var mongoose = require('mongoose'),
  Schema = mongoose.Schema;

var TimelockUtxoInfoSchema = new Schema({
  iscltv: { type: Boolean, default: false },
  istimebased: { type: Boolean, default: false },
  isexpired: { type: Boolean, default: false },
  locktime: { type: Number, default: 0 },
  timetouse_number: { type: Number, default: 0 },
  timetouse_string: { type: String, default: '' },
});

// Store all UTXOs of addresses which relate to transactions in mempool
var AddressUtxoMempoolSchema = new Schema({
  blockheight: { type: Number, default: 0, index: true },
  a_id: { type: String, index: true },
  blockutxoheight: { type: Number, default: 0, index: true },
  txid: { type: String, lowercase: true, index: true },
  vout: { type: Number, default: 0 },
  isused: { type: Boolean, default: false },
  amount: { type: Number, default: 0 },
  timelockinfo: TimelockUtxoInfoSchema, // by default (not timelock UTXO) = undefined
});

AddressUtxoMempoolSchema.index({ blockheight: 1, a_id: 1, isused: 1 });

module.exports = mongoose.model('AddressUtxoMempool', AddressUtxoMempoolSchema);
