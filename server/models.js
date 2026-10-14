const m = require('mongoose'); const S = m.Schema; const loc = { lat: Number, lng: Number };
exports.User = m.model('User', new S({ name: String, email: { type: String, unique: true, lowercase: true }, password: String, phone: String,
  role: { type: String, enum: ['citizen', 'volunteer', 'ngo', 'authority', 'admin'], default: 'citizen' } }, { timestamps: true }));
exports.Incident = m.model('Incident', new S({ type: String, description: String, severity: { type: String, enum: ['low', 'moderate', 'high', 'critical'] },
  location: loc, address: String, waterLevel: String, peopleAffected: { type: Number, default: 0 }, peopleNeedingRescue: { type: Number, default: 0 },
  roadBlocked: Boolean, infraDamage: Boolean, images: [String], isSOS: Boolean, reportedBy: { type: S.Types.ObjectId, ref: 'User' },
  verification: { type: String, enum: ['pending', 'verified', 'rejected', 'duplicate'], default: 'pending' },
  status: { type: String, enum: ['open', 'assigned', 'en_route', 'in_progress', 'resolved'], default: 'open' },
  priorityScore: Number, priorityLabel: String, duplicateOf: { type: S.Types.ObjectId, ref: 'Incident' }, dupCount: { type: Number, default: 0 } }, { timestamps: true }));
exports.Mission = m.model('Mission', new S({ code: String, incident: { type: S.Types.ObjectId, ref: 'Incident' }, team: { type: S.Types.ObjectId, ref: 'User' },
  resources: [String], notes: String, status: { type: String, enum: ['assigned', 'en_route', 'in_progress', 'completed', 'cancelled'], default: 'assigned' },
  startTime: Date, completionTime: Date }, { timestamps: true }));
const R = { timestamps: true };
exports.Resource = m.model('Resource', new S({ name: String, type: String, quantity: { type: Number, default: 1 }, location: loc,
  status: { type: String, enum: ['available', 'in_use', 'unavailable', 'maintenance'], default: 'available' }, assignedMission: { type: S.Types.ObjectId, ref: 'Mission' }, owner: { type: S.Types.ObjectId, ref: 'User' } }, R));
exports.Shelter = m.model('Shelter', new S({ name: String, address: String, location: loc, capacity: Number, occupied: { type: Number, default: 0 }, facilities: [String], contact: String }, R));
exports.Alert = m.model('Alert', new S({ title: String, message: String, createdBy: { type: S.Types.ObjectId, ref: 'User' } }, R));
