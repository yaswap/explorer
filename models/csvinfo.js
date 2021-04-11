var mongoose = require('mongoose')
  , Schema = mongoose.Schema;
 
var CsvUtxoInfoSchema = new Schema({
    a_id: { type: String, index: true},
    txid: { type: String, lowercase: true, index: true},
    isused: { type: Boolean, default: false },
    amount: { type: Number, default: 0 },
    timetouse_number: { type: Number, default: 0 },
    timetouse_string: { type: String, default: "" },
  });

module.exports = mongoose.model('CsvInfo', CsvUtxoInfoSchema);