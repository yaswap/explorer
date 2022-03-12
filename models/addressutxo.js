var mongoose = require('mongoose')
  , Schema = mongoose.Schema;

var AddressUtxoSchema = new Schema({
    a_id: { type: String, index: true},
    txid: { type: String, lowercase: true, index: true},
    vout: { type: Number, default: 0 },
    isused: { type: Boolean, default: false },
    amount: { type: Number, default: 0 },
});

AddressUtxoSchema.index({a_id: 1, isused: 1});

module.exports = mongoose.model('AddressUtxo', AddressUtxoSchema);