var mongoose = require('mongoose'),
  Schema = mongoose.Schema;

var BlockSchema = new Schema(
  {
    blockheight: { type: Number, unique: true, index: true },
    blockhash: { type: String, lowercase: true, unique: true, index: true },
    blocktime: { type: Number, default: 0, index: true },
  },
  { id: false }
);

BlockSchema.index({ total: 1, total: -1, blockindex: 1, blockindex: -1 });

module.exports = mongoose.model('Block', BlockSchema);
