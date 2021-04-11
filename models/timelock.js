var mongoose = require('mongoose')
  , Schema = mongoose.Schema;
 
var CsvInfoSchema = new Schema({
    txid: { type: String, lowercase: true, unique: true, index: true},
    isused: { type: Boolean, default: false },
    timetouse: { type: Number, default: 0 },
  });
  
var TimeLockSchema = new Schema({
    a_id: { type: String, unique: true, index: true, default: ""},
    redeemscript: { type: String, unique: true, index: true, default: ""},
    iscltv: { type: Boolean, default: true },
    istimebased: { type: Boolean, default: true },
    locktime: { type: Number, default: 0 },
    description: { type: String, default: "" },
    csvinfo: { type: Array, default: [] },
    balance: {type: Number, default: 0, index: true},
});

module.exports = mongoose.model('TimeLock', TimeLockSchema);