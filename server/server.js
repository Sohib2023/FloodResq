require('dotenv').config();
const express = require('express'), http = require('http'), mongoose = require('mongoose'), jwt = require('jsonwebtoken'), bcrypt = require('bcryptjs');
const multer = require('multer'), path = require('path'), cors = require('cors'), rateLimit = require('express-rate-limit'); const { Server } = require('socket.io');
const { User, Incident, Mission, Resource, Shelter, Alert } = require('./models');
const SECRET = process.env.JWT_SECRET; if (!SECRET) { console.error('Set JWT_SECRET in .env'); process.exit(1); }
const app = express(), server = http.createServer(app), io = new Server(server, { cors: { origin: '*' } });
app.use(cors(), express.json(), rateLimit({ windowMs: 60000, max: 300 }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads'))); app.use(express.static(path.join(__dirname, '../public')));
const upload = multer({ dest: path.join(__dirname, 'uploads'), limits: { fileSize: 5e6, files: 5 }, fileFilter: (q, f, cb) => cb(null, /^image\//.test(f.mimetype)) });
const h = fn => (req, res) => fn(req, res).catch(e => res.status(500).json({ error: e.message }));
const auth = (roles = []) => (req, res, next) => {
  try { req.user = jwt.verify((req.headers.authorization || '').split(' ')[1], SECRET); } catch { return res.status(401).json({ error: 'Please log in' }); }
  if (roles.length && !roles.includes(req.user.role)) return res.status(403).json({ error: 'Not allowed for your role' }); next(); };
const AUTH = ['authority', 'admin'], FIELD = ['volunteer', 'ngo'];

// Rule-based priority score (0-100). Swap this function for an ML service later.
function priority(i) {
  const sev = { low: 1, moderate: 2, high: 3, critical: 4 }[i.severity] || 1;
  let s = sev / 4 * 30 + Math.min(i.peopleAffected, 20) / 20 * 10 + Math.min(i.peopleNeedingRescue, 10) / 10 * 25
    + (i.roadBlocked ? 10 : 0) + (i.infraDamage ? 10 : 0) + (i.verification === 'verified' ? 15 : 0);
  if (i.isSOS) s = 100; s = Math.round(Math.min(s, 100));
  return { priorityScore: s, priorityLabel: s <= 25 ? 'Low' : s <= 50 ? 'Moderate' : s <= 75 ? 'High' : 'Critical' }; }

// Auth
app.post('/api/auth/register', h(async (req, res) => {
  const { name, email, password, phone, role } = req.body;
  if (!name || !/^\S+@\S+$/.test(email || '') || (password || '').length < 6) return res.status(400).json({ error: 'Valid name, email and 6+ char password required' });
  if (await User.findOne({ email })) return res.status(409).json({ error: 'Email already registered' });
  const u = await User.create({ name, email, phone, role: ['citizen', 'volunteer', 'ngo'].includes(role) ? role : 'citizen', password: await bcrypt.hash(password, 10) });
  res.json(session(u)); }));
app.post('/api/auth/login', h(async (req, res) => {
  const u = await User.findOne({ email: (req.body.email || '').toLowerCase() });
  if (!u || !(await bcrypt.compare(req.body.password || '', u.password))) return res.status(401).json({ error: 'Invalid email or password' }); res.json(session(u)); }));
const session = u => ({ token: jwt.sign({ id: u._id, role: u.role, name: u.name }, SECRET, { expiresIn: '7d' }), user: { id: u._id, name: u.name, role: u.role } });
app.get('/api/volunteers', auth(AUTH), h(async (q, r) => r.json(await User.find({ role: { $in: FIELD } }).select('name role'))));

// Incidents: create (with duplicate detection), list, verify/reject/resolve
app.get('/api/incidents', auth(), h(async (req, res) => {
  const f = { verification: { $ne: 'duplicate' } }; if (req.user.role === 'citizen') f.$or = [{ verification: 'verified' }, { reportedBy: req.user.id }];
  res.json(await Incident.find(f).sort({ priorityScore: -1, createdAt: -1 }).limit(300)); }));
app.post('/api/incidents', auth(), upload.array('images', 5), h(async (req, res) => {
  const b = req.body, lat = +b.lat, lng = +b.lng;
  if (!isFinite(lat) || !isFinite(lng) || !b.type || !b.severity) return res.status(400).json({ error: 'Type, severity and map location are required' });
  const doc = { type: b.type, description: b.description, severity: b.severity, location: { lat, lng }, waterLevel: b.waterLevel, address: b.address,
    peopleAffected: +b.peopleAffected || 0, peopleNeedingRescue: +b.peopleNeedingRescue || 0, roadBlocked: b.roadBlocked === 'true', infraDamage: b.infraDamage === 'true',
    images: (req.files || []).map(f => '/uploads/' + f.filename), reportedBy: req.user.id, isSOS: b.isSOS === 'true' };
  // Duplicate: same type within ~200 m and 2 hours
  const d = 0.002, dup = await Incident.findOne({ type: doc.type, verification: { $ne: 'duplicate' }, createdAt: { $gt: new Date(Date.now() - 7200000) },
    'location.lat': { $gt: lat - d, $lt: lat + d }, 'location.lng': { $gt: lng - d, $lt: lng + d } });
  if (dup) { doc.verification = 'duplicate'; doc.duplicateOf = dup._id; await Incident.findByIdAndUpdate(dup._id, { $inc: { dupCount: 1 } }); }
  const inc = await Incident.create({ ...doc, ...priority(doc) });
  io.emit(dup ? 'incidentUpdated' : 'newIncident', dup ? await Incident.findById(dup._id) : inc); res.json({ incident: inc, duplicateOf: dup && dup._id }); }));
const setVerification = v => h(async (req, res) => {
  const inc = await Incident.findById(req.params.id); if (!inc) return res.status(404).json({ error: 'Not found' });
  inc.verification = v; Object.assign(inc, priority(inc)); await inc.save(); io.emit(v === 'verified' ? 'incidentVerified' : 'incidentUpdated', inc); res.json(inc); });
app.post('/api/incidents/:id/verify', auth(AUTH), setVerification('verified'));
app.post('/api/incidents/:id/reject', auth(AUTH), setVerification('rejected'));

// Missions
app.get('/api/missions', auth(), h(async (req, res) => {
  const f = AUTH.includes(req.user.role) ? {} : FIELD.includes(req.user.role) ? { team: req.user.id } : null;
  res.json(f ? await Mission.find(f).populate('incident').populate('team', 'name').sort({ createdAt: -1 }) : []); }));
app.post('/api/missions', auth(AUTH), h(async (req, res) => {
  const inc = await Incident.findById(req.body.incident); if (!inc) return res.status(404).json({ error: 'Incident not found' });
  const m = await Mission.create({ code: 'RES-' + (1000 + await Mission.countDocuments() + 1), incident: inc._id, team: req.body.team, resources: req.body.resources || [], notes: req.body.notes });
  inc.status = 'assigned'; await inc.save(); await Resource.updateMany({ _id: { $in: req.body.resourceIds || [] } }, { status: 'in_use', assignedMission: m._id }); io.emit('missionAssigned', m); io.emit('incidentUpdated', inc); res.json(m); }));
const MAP = { en_route: 'en_route', in_progress: 'in_progress', completed: 'resolved' };
app.put('/api/missions/:id', auth([...AUTH, ...FIELD]), h(async (req, res) => {
  const m = await Mission.findById(req.params.id); if (!m) return res.status(404).json({ error: 'Not found' });
  if (FIELD.includes(req.user.role) && String(m.team) !== req.user.id) return res.status(403).json({ error: 'Not your mission' });
  const s = req.body.status; if (!['en_route', 'in_progress', 'completed', 'cancelled'].includes(s)) return res.status(400).json({ error: 'Bad status' });
  m.status = s; if (s === 'in_progress') m.startTime = new Date(); if (s === 'completed') m.completionTime = new Date(); await m.save();
  const inc = await Incident.findById(m.incident); inc.status = MAP[s] || 'open'; await inc.save();
  io.emit('missionUpdated', m); io.emit('incidentUpdated', inc); res.json(m); }));
app.get('/api/stats', auth(AUTH), h(async (q, res) => {
  const [active, critical, rescue, resolved] = await Promise.all([Incident.countDocuments({ status: { $ne: 'resolved' }, verification: { $in: ['pending', 'verified'] } }),
    Incident.countDocuments({ priorityLabel: 'Critical', status: { $ne: 'resolved' } }), Incident.aggregate([{ $match: { status: { $ne: 'resolved' } } }, { $group: { _id: null, n: { $sum: '$peopleNeedingRescue' } } }]),
    Incident.countDocuments({ status: 'resolved' })]); res.json({ active, critical, peopleNeedingRescue: rescue[0]?.n || 0, resolved }); }));


// Resources
app.get('/api/resources', auth(), h(async (q, r) => r.json(await Resource.find().sort({ updatedAt: -1 }))));
app.post('/api/resources', auth([...AUTH, ...FIELD]), h(async (req, res) => {
  const b = req.body; if (!b.name || !b.type) return res.status(400).json({ error: 'Name and type required' });
  const r = await Resource.create({ name: b.name, type: b.type, quantity: +b.quantity || 1, location: { lat: +b.lat || 28.367, lng: +b.lng || 79.43 }, owner: req.user.id });
  io.emit('resourceUpdated', r); res.json(r); }));
app.put('/api/resources/:id', auth([...AUTH, ...FIELD]), h(async (req, res) => {
  const r = await Resource.findByIdAndUpdate(req.params.id, { status: req.body.status }, { new: true }); io.emit('resourceUpdated', r); res.json(r); }));
// Shelters
app.get('/api/shelters', auth(), h(async (q, r) => r.json(await Shelter.find())));
app.post('/api/shelters', auth(AUTH), h(async (req, res) => { const s = await Shelter.create(req.body); res.json(s); }));
// Alerts (broadcast over Socket.IO)
app.get('/api/alerts', auth(), h(async (q, r) => r.json(await Alert.find().sort({ createdAt: -1 }).limit(5))));
app.post('/api/alerts', auth(AUTH), h(async (req, res) => {
  if (!req.body.title || !req.body.message) return res.status(400).json({ error: 'Title and message required' });
  const a = await Alert.create({ title: req.body.title, message: req.body.message, createdBy: req.user.id }); io.emit('newAlert', a); res.json(a); }));
// Merge duplicates into a primary incident
app.post('/api/incidents/:id/merge', auth(AUTH), h(async (req, res) => {
  await Incident.updateMany({ duplicateOf: req.params.id }, { status: 'resolved' });
  const inc = await Incident.findByIdAndUpdate(req.params.id, { dupCount: 0 }, { new: true }); io.emit('incidentMerged', inc); res.json(inc); }));
// Analytics
app.get('/api/analytics', auth(AUTH), h(async (q, res) => {
  const g = f => Incident.aggregate([{ $group: { _id: '$' + f, n: { $sum: 1 } } }]);
  const [bySeverity, byType, byVerification, byDay, resp] = await Promise.all([g('priorityLabel'), g('type'), g('verification'),
    Incident.aggregate([{ $match: { createdAt: { $gt: new Date(Date.now() - 7 * 864e5) } } }, { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, n: { $sum: 1 } } }, { $sort: { _id: 1 } }]),
    Mission.aggregate([{ $match: { status: 'completed', startTime: { $ne: null } } }, { $group: { _id: null, m: { $avg: { $divide: [{ $subtract: ['$completionTime', '$startTime'] }, 60000] } } } }])]);
  res.json({ bySeverity, byType, byVerification, byDay, avgRescueMinutes: Math.round(resp[0]?.m || 0) }); }));
async function seedExtra() {
  if (!(await Shelter.countDocuments())) await Shelter.insertMany([
    { name: 'Govt School No. 2', address: 'Civil Lines, Bareilly', location: { lat: 28.372, lng: 79.425 }, capacity: 300, occupied: 40, facilities: ['Food', 'Water', 'Toilets'], contact: '0581-000001' },
    { name: 'Community Hall, Model Town', address: 'Model Town, Bareilly', location: { lat: 28.385, lng: 79.45 }, capacity: 150, occupied: 10, facilities: ['Food', 'Medical'], contact: '0581-000002' }]);
  if (!(await Resource.countDocuments())) await Resource.insertMany([
    { name: 'Rescue Boat 1', type: 'Boat', quantity: 1, location: { lat: 28.36, lng: 79.42 } }, { name: 'Rescue Boat 2', type: 'Boat', quantity: 1, location: { lat: 28.37, lng: 79.44 } },
    { name: 'Ambulance A', type: 'Ambulance', quantity: 1, location: { lat: 28.355, lng: 79.43 } }, { name: 'Pump Unit 1', type: 'Water pump', quantity: 2, location: { lat: 28.35, lng: 79.41 } }]); }
async function seed() {
  if (await User.countDocuments()) return; const pw = await bcrypt.hash('Demo@1234', 10);
  for (const r of ['citizen', 'volunteer', 'ngo', 'authority', 'admin']) await User.create({ name: r[0].toUpperCase() + r.slice(1) + ' Demo', email: `${r}@floodresq.demo`, password: pw, role: r });
  const c = await User.findOne({ role: 'citizen' });
  for (const [type, severity, lat, lng, a, n, address] of [['Stranded People', 'critical', 28.367, 79.43, 15, 10, 'Civil Lines, Bareilly'], ['Waterlogging', 'high', 28.35, 79.41, 0, 0, 'Station Road, Bareilly'], ['Drainage Overflow', 'moderate', 28.38, 79.45, 3, 0, 'Model Town, Bareilly']]) {
    const d = { type, severity, location: { lat, lng }, address, peopleAffected: a, peopleNeedingRescue: n, roadBlocked: n > 0, verification: 'verified', reportedBy: c._id };
    await Incident.create({ ...d, ...priority(d) }); }
  console.log('Seeded demo data (password Demo@1234)'); }
mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/floodresq').then(seed).then(seedExtra).then(() => server.listen(process.env.PORT || 5000, () => console.log('FloodResQ on http://localhost:' + (process.env.PORT || 5000))))
  .catch(e => { console.error('MongoDB error:', e.message); process.exit(1); });
