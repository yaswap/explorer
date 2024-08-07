var mongoose = require('mongoose'),
  Schema = mongoose.Schema;

var TimelockUtxoInfoSchema = new Schema({
  iscltv: { type: Boolean, default: false },
  istimebased: { type: Boolean, default: false },
  isexpired: { type: Boolean, default: false },
  locktime: { type: Number, default: 0 },
  timetouse_number: { type: Number, default: 0 },
  timetouse_string: { type: String, default: '' },
  scriptpubkey: { type: String, index: true, default: '' }, // if it is not empty => P2PKH script
});

var AddressUtxoSchema = new Schema({
  a_id: { type: String, index: true },
  txid: { type: String, lowercase: true, index: true },
  vout: { type: Number, default: 0 },
  isused: { type: Boolean, default: false },
  amount: { type: Number, default: 0 },
  timelockinfo: TimelockUtxoInfoSchema, // by default (not timelock UTXO) = undefined
});

AddressUtxoSchema.index({ a_id: 1, isused: 1 });

module.exports = {
  TimelockUtxoInfo: mongoose.model('TimelockUtxoInfo', TimelockUtxoInfoSchema),
  AddressUtxo: mongoose.model('AddressUtxo', AddressUtxoSchema),
};
