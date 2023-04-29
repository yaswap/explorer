var mongoose = require('mongoose'),
  Schema = mongoose.Schema;

/*
+ a_id
Unique address

+ redeemscript
If it is empty => P2PKH script

+ locktime
If it is 0 => P2PKH script

+ type
CLTV_P2PKH_timelock, CSV_P2PKH_timelock, CLTV_P2SH_timelock_blockbased, CLTV_P2SH_timelock_timebased, CSV_P2SH_timelock_blockbased, CSV_P2SH_timelock_timebased

+ description
CLTV_P2SH_timelock => This P2SH address uses OP_CHECKLOCKTIMEVERIFY opcode. Any coins sent to this address will be locked until ...
CSV_P2SH_timelock => This P2SH address uses OP_CHECKSEQUENCEVERIFY opcode. Any coins sent to this address will be locked within ...
CLTV_P2PKH_timelock, CSV_P2PKH_timelock => This normal P2PKH address contains some timelock UTXOs.

+ balance
Total timelock coins, need update frequently
*/

var TimeLockSchema = new Schema({
  a_id: { type: String, unique: true, index: true, default: '' }, // Unique
  redeemscript: { type: String, index: true, default: '' }, // if it is empty => P2PKH script
  locktime: { type: Number, default: 0 }, // if it is 0 => P2PKH script
  type: {
    type: String,
    index: true,
    required: [true, 'A timelock must have a type'],
  }, // CLTV_P2SH_timelock, CSV_P2SH_timelock, CLTV_P2PKH_timelock, CSV_P2PKH_timelock
  description: {
    type: String,
    required: [true, 'A timelock must have a description'],
  }, //
  balance: { type: Number, default: 0, index: true }, // Total timelock coins
});

module.exports = mongoose.model('TimeLock', TimeLockSchema);
