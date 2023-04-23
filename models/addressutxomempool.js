var mongoose = require('mongoose'),
  Schema = mongoose.Schema;

var TimelockUtxoInfoSchema = new Schema({
  iscltv: Boolean,
  istimebased: Boolean,
  locktime: Number,
  timetouse_number: Number,
  timetouse_string: String,
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
