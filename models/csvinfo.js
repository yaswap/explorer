var mongoose = require('mongoose')
  , Schema = mongoose.Schema;
 
var CsvInfoSchema = new Schema({
    a_id: { type: String, unique: true, index: true, default: ""},
    txid: { type: String, lowercase: true, unique: true, index: true},
    vout: { type: Number, default: 0 },
    isused: { type: Boolean, default: false },
    amount: { type: Number, default: 0 },
    timetouse_number: { type: Number, default: 0 },
    timetouse_string: { type: String, default: "" },
  });

module.exports = mongoose.model('CsvInfo', TimeLockSchema);