var request = require('request'),
  settings = require('./settings'),
  Address = require('../models/address'),
  { TimelockUtxoInfo, AddressUtxo } = require('../models/addressutxo'),
  TimeLock = require('../models/timelock');

var base_url = 'http://127.0.0.1:' + settings.port + '/api/';

const Client = require('bitcoin-core');
const client = new Client(settings.wallet);
const SEQUENCE_LOCKTIME_TYPE_FLAG = 1 << 30;
const SEQUENCE_LOCKTIME_MASK = 0x3fffffff;
const SEQUENCE_LOCKTIME_GRANULARITY = 0;
const CLTV_LOCKTIME_THRESHOLD = 500000000;
const ScriptPubKeyType = {
  CLTV_P2PKH_timelock: 'CLTV_P2PKH_timelock',
  CSV_P2PKH_timelock: 'CSV_P2PKH_timelock',
  CLTV_P2SH_timelock_blockbased: 'CLTV_P2SH_timelock_blockbased',
  CLTV_P2SH_timelock_timebased: 'CLTV_P2SH_timelock_timebased',
  CSV_P2SH_timelock_blockbased: 'CSV_P2SH_timelock_blockbased',
  CSV_P2SH_timelock_timebased: 'CSV_P2SH_timelock_timebased',
};
// returns coinbase total sent as current coin supply
function coinbase_supply(cb) {
  Address.findOne({ a_id: 'coinbase' }, function (err, address) {
    if (address) {
      return cb(address.sent);
    } else {
      return cb(0);
    }
  });
}

function rpcCommand(params, cb) {
  client.command([{ method: params[0].method, parameters: params[0].parameters }], function (err, response) {
    if (err) {
      console.log('Error during RPC command call: ', err);
      console.log('Exiting due to RPC command call error');
      return cb('There was an rpc command call error. Check your console.');
    } else {
      if (response[0].name == 'RpcError') {
        return cb('There was an error. Check your console.');
      }
      return cb(response[0]);
    }
  });
}

async function prepare_P2SH_timelock_info(timelockaddress, block) {
  var newTimeLockUtxoInfo = new TimelockUtxoInfo();
  // CLTV
  if (timelockaddress.type.includes('CLTV_P2SH_timelock')) {
    // Prepare TimelockUtxoInfo
    newTimeLockUtxoInfo.iscltv = true;
    newTimeLockUtxoInfo.locktime = timelockaddress.locktime;
    newTimeLockUtxoInfo.timetouse_number = newTimeLockUtxoInfo.locktime;

    if (timelockaddress.type === ScriptPubKeyType.CLTV_P2SH_timelock_timebased) {
      // Time-based lock
      newTimeLockUtxoInfo.istimebased = true;
      const date = new Date(newTimeLockUtxoInfo.timetouse_number * 1000);
      newTimeLockUtxoInfo.timetouse_string += 'unlock at ' + date.toLocaleString();
    } else {
      // Block-based lock
      newTimeLockUtxoInfo.istimebased = false;
      newTimeLockUtxoInfo.timetouse_string += 'unlock at block height ' + newTimeLockUtxoInfo.timetouse_number;
    }
    // CSV
  } else {
    // Prepare TimelockUtxoInfo
    newTimeLockUtxoInfo.iscltv = false;
    newTimeLockUtxoInfo.locktime = timelockaddress.locktime;

    if (timelockaddress.type === ScriptPubKeyType.CSV_P2SH_timelock_timebased) {
      // Time-based lock
      newTimeLockUtxoInfo.istimebased = true;

      newTimeLockUtxoInfo.timetouse_number = newTimeLockUtxoInfo.locktime + block.time;

      const date = new Date(newTimeLockUtxoInfo.timetouse_number * 1000);
      newTimeLockUtxoInfo.timetouse_string += 'unlock at ' + date.toLocaleString();
    } else {
      // Block-based lock
      newTimeLockUtxoInfo.istimebased = false;
      newTimeLockUtxoInfo.timetouse_number = newTimeLockUtxoInfo.locktime + block.height;
      newTimeLockUtxoInfo.timetouse_string += 'unlock at block height ' + newTimeLockUtxoInfo.timetouse_number;
    }
  }

  return newTimeLockUtxoInfo;
}

async function parse_P2PKH_timelock_script(vout, block) {
  // Create new TimeLock document if not existing
  var address = vout.scriptPubKey.addresses[0];
  var timelockDesc = 'This normal P2PKH address contains some timelock UTXOs';
  var timelockType = vout.scriptPubKey.type;
  await TimeLock.findOneAndUpdate(
    { a_id: address },
    {
      type: timelockType,
      description: timelockDesc,
    },
    {
      new: true, // return the modified document rather than the original
      upsert: true, // creates the object if it doesn't exist. defaults to false.
    }
  );

  // Prepare new TimeLockUtxoInfo document
  var newTimeLockUtxoInfo = new TimelockUtxoInfo();
  newTimeLockUtxoInfo.scriptpubkey = vout.scriptPubKey.hex;
  newTimeLockUtxoInfo.locktime = parseInt(vout.scriptPubKey.asm.substr(0, vout.scriptPubKey.asm.indexOf(' ')));
  newTimeLockUtxoInfo.isexpired = false;

  if (timelockType == ScriptPubKeyType.CLTV_P2PKH_timelock) {
    // CLTV
    newTimeLockUtxoInfo.iscltv = true;
    if (newTimeLockUtxoInfo.locktime < CLTV_LOCKTIME_THRESHOLD) {
      // Block-based lock
      newTimeLockUtxoInfo.istimebased = false;
      newTimeLockUtxoInfo.timetouse_number = newTimeLockUtxoInfo.locktime;
      newTimeLockUtxoInfo.timetouse_string = 'unlock at block height ' + newTimeLockUtxoInfo.timetouse_number;
    } else {
      // Time-based lock
      newTimeLockUtxoInfo.istimebased = true;
      newTimeLockUtxoInfo.timetouse_number = newTimeLockUtxoInfo.locktime;
      const date = new Date(newTimeLockUtxoInfo.timetouse_number * 1000);
      newTimeLockUtxoInfo.timetouse_string += 'unlock at ' + date.toLocaleString();
    }
  } else {
    // CSV
    newTimeLockUtxoInfo.iscltv = false;
    if (newTimeLockUtxoInfo.locktime & SEQUENCE_LOCKTIME_TYPE_FLAG) {
      // Time-based lock
      // Convert to real seconds
      newTimeLockUtxoInfo.locktime =
        (newTimeLockUtxoInfo.locktime & SEQUENCE_LOCKTIME_MASK) << SEQUENCE_LOCKTIME_GRANULARITY;

      newTimeLockUtxoInfo.istimebased = true;

      newTimeLockUtxoInfo.timetouse_number = newTimeLockUtxoInfo.locktime + block.time;

      const date = new Date(newTimeLockUtxoInfo.timetouse_number * 1000);
      newTimeLockUtxoInfo.timetouse_string += 'unlock at ' + date.toLocaleString();
    } else {
      // Block-based lock
      newTimeLockUtxoInfo.istimebased = false;
      newTimeLockUtxoInfo.timetouse_number = newTimeLockUtxoInfo.locktime + block.height;
      newTimeLockUtxoInfo.timetouse_string = 'unlock at block height ' + newTimeLockUtxoInfo.timetouse_number;
    }
  }
  return newTimeLockUtxoInfo;
}

module.exports = {
  SEQUENCE_LOCKTIME_TYPE_FLAG,
  SEQUENCE_LOCKTIME_MASK,
  SEQUENCE_LOCKTIME_GRANULARITY,
  CLTV_LOCKTIME_THRESHOLD,
  ScriptPubKeyType,
  convert_to_satoshi: function (amount, cb) {
    // fix to 8dp & convert to string
    var fixed = amount.toFixed(6).toString();
    // remove decimal (.) and return integer
    return cb(parseInt(fixed.replace('.', '')));
  },

  get_timelockutxoinfo: async function (vout, block, blockhash) {
    var timelockUtxoInfo = null;
    // Check if it is P2PKH timelock
    if (
      vout.scriptPubKey.type === ScriptPubKeyType.CLTV_P2PKH_timelock ||
      vout.scriptPubKey.type === ScriptPubKeyType.CSV_P2PKH_timelock
    ) {
      if (vout.scriptPubKey.type == ScriptPubKeyType.CSV_P2PKH_timelock && Object.keys(block).length === 0) {
        block = await module.exports.get_block_promise(blockhash);
      }
      timelockUtxoInfo = await parse_P2PKH_timelock_script(vout, block);
    } else {
      // Check if it is P2SH timelock address
      const timelockaddress = await TimeLock.findOne({ a_id: vout.scriptPubKey.addresses[0] });
      if (
        timelockaddress &&
        timelockaddress.type !== ScriptPubKeyType.CLTV_P2PKH_timelock &&
        timelockaddress.type !== ScriptPubKeyType.CSV_P2PKH_timelock
      ) {
        if (timelockaddress.type.includes('CSV_P2SH_timelock') && Object.keys(block).length === 0) {
          block = await module.exports.get_block_promise(blockhash);
        }
        timelockUtxoInfo = await prepare_P2SH_timelock_info(timelockaddress, block);
      }
    }
    return { block, timelockUtxoInfo };
  },

  get_hashrate: function (cb) {
    if (settings.index.show_hashrate == false) return cb('-');
    if (settings.use_rpc) {
      if (settings.nethash == 'netmhashps') {
        rpcCommand([{ method: 'getmininginfo', parameters: [] }], function (response) {
          if (response == 'There was an error. Check your console.') {
            return cb(response);
          }
          if (response.netmhashps) {
            response.netmhashps = parseFloat(response.netmhashps);
            if (settings.nethash_units == 'K') {
              return cb((response.netmhashps * 1000).toFixed(4));
            } else if (settings.nethash_units == 'G') {
              return cb((response.netmhashps / 1000).toFixed(4));
            } else if (settings.nethash_units == 'H') {
              return cb((response.netmhashps * 1000000).toFixed(4));
            } else if (settings.nethash_units == 'T') {
              return cb((response.netmhashps / 1000000).toFixed(4));
            } else if (settings.nethash_units == 'P') {
              return cb((response.netmhashps / 1000000000).toFixed(4));
            } else {
              return cb(response.netmhashps.toFixed(4));
            }
          } else {
            return cb('-');
          }
        });
      } else {
        rpcCommand([{ method: 'getnetworkhashps', parameters: [] }], function (response) {
          if (response == 'There was an error. Check your console.') {
            return cb(response);
          }
          if (response) {
            response = parseFloat(response);
            if (settings.nethash_units == 'K') {
              return cb((response / 1000).toFixed(4));
            } else if (settings.nethash_units == 'M') {
              return cb((response / 1000000).toFixed(4));
            } else if (settings.nethash_units == 'G') {
              return cb((response / 1000000000).toFixed(4));
            } else if (settings.nethash_units == 'T') {
              return cb((response / 1000000000000).toFixed(4));
            } else if (settings.nethash_units == 'P') {
              return cb((response / 1000000000000000).toFixed(4));
            } else {
              return cb(response.toFixed(4));
            }
          } else {
            return cb('-');
          }
        });
      }
    } else {
      if (settings.nethash == 'netmhashps') {
        var uri = base_url + 'getmininginfo';
        request({ uri: uri, json: true }, function (error, response, body) {
          //returned in mhash
          if (body.netmhashps) {
            if (settings.nethash_units == 'K') {
              return cb((body.netmhashps * 1000).toFixed(4));
            } else if (settings.nethash_units == 'G') {
              return cb((body.netmhashps / 1000).toFixed(4));
            } else if (settings.nethash_units == 'H') {
              return cb((body.netmhashps * 1000000).toFixed(4));
            } else if (settings.nethash_units == 'T') {
              return cb((body.netmhashps / 1000000).toFixed(4));
            } else if (settings.nethash_units == 'P') {
              return cb((body.netmhashps / 1000000000).toFixed(4));
            } else {
              return cb(body.netmhashps.toFixed(4));
            }
          } else {
            return cb('-');
          }
        });
      } else {
        var uri = base_url + 'getnetworkhashps';
        request({ uri: uri, json: true }, function (error, response, body) {
          if (body == 'There was an error. Check your console.') {
            return cb('-');
          } else {
            if (settings.nethash_units == 'K') {
              return cb((body / 1000).toFixed(4));
            } else if (settings.nethash_units == 'M') {
              return cb((body / 1000000).toFixed(4));
            } else if (settings.nethash_units == 'G') {
              return cb((body / 1000000000).toFixed(4));
            } else if (settings.nethash_units == 'T') {
              return cb((body / 1000000000000).toFixed(4));
            } else if (settings.nethash_units == 'P') {
              return cb((body / 1000000000000000).toFixed(4));
            } else {
              return cb(body.toFixed(4));
            }
          }
        });
      }
    }
  },

  get_difficulty: function (cb) {
    if (settings.use_rpc) {
      rpcCommand([{ method: 'getdifficulty', parameters: [] }], function (response) {
        return cb(response);
      });
    } else {
      var uri = base_url + 'getdifficulty';
      request({ uri: uri, json: true }, function (error, response, body) {
        return cb(body);
      });
    }
  },

  get_connectioncount: function (cb) {
    if (settings.use_rpc) {
      rpcCommand([{ method: 'getconnectioncount', parameters: [] }], function (response) {
        return cb(response);
      });
    } else {
      var uri = base_url + 'getconnectioncount';
      request({ uri: uri, json: true }, function (error, response, body) {
        return cb(body);
      });
    }
  },

  get_blockcount: function (cb) {
    if (settings.use_rpc) {
      rpcCommand([{ method: 'getblockcount', parameters: [] }], function (response) {
        return cb(response);
      });
    } else {
      var uri = base_url + 'getblockcount';
      request({ uri: uri, json: true }, function (error, response, body) {
        return cb(body);
      });
    }
  },

  get_blockhash: function (height, cb) {
    if (settings.use_rpc) {
      rpcCommand([{ method: 'getblockhash', parameters: [parseInt(height)] }], function (response) {
        return cb(response);
      });
    } else {
      var uri = base_url + 'getblockhash?height=' + height;
      request({ uri: uri, json: true }, function (error, response, body) {
        return cb(body);
      });
    }
  },

  get_block: function (hash, cb) {
    if (settings.use_rpc) {
      rpcCommand([{ method: 'getblock', parameters: [hash] }], function (response) {
        return cb(response);
      });
    } else {
      var uri = base_url + 'getblock?hash=' + hash;
      request({ uri: uri, json: true }, function (error, response, body) {
        return cb(body);
      });
    }
  },

  get_block_promise: function (hash) {
    return new Promise((resolve, reject) => {
      module.exports.get_block(hash, (response) => {
        resolve(response);
      });
    });
  },

  get_block_by_number: function (blockheight, cb) {
    rpcCommand([{ method: 'getblockbynumber', parameters: [blockheight] }], function (response) {
      return cb(response);
    });
  },

  get_block_by_number_promise: function (blockheight) {
    return new Promise((resolve, reject) => {
      module.exports.get_block_by_number(blockheight, (response) => {
        resolve(response);
      });
    });
  },

  get_rawmempool: function (cb) {
    rpcCommand([{ method: 'getrawmempool', parameters: [] }], function (response) {
      return cb(response);
    });
  },

  describe_redeemscript: function (redeemscript, cb) {
    rpcCommand([{ method: 'describeredeemscript', parameters: [redeemscript] }], function (response) {
      return cb(response);
    });
  },

  send_rawtransaction: function (rawtransaction, cb) {
    rpcCommand([{ method: 'sendrawtransaction', parameters: [rawtransaction] }], function (response) {
      return cb(response);
    });
  },

  get_token_info: function (tokenName, verbose, cb) {
    rpcCommand([{ method: 'listtokens', parameters: [tokenName, verbose] }], function (response) {
      return cb(response);
    });
  },

  get_token_info_promise: function (tokenName, verbose) {
    return new Promise((resolve, reject) => {
      module.exports.get_token_info(tokenName, verbose, (response) => {
        resolve(response);
      });
    });
  },

  get_token_utxos: function (queryObj, cb) {
    rpcCommand([{ method: 'getaddressutxos', parameters: [queryObj] }], function (response) {
      return cb(response);
    });
  },

  get_token_utxos_promise: function (queryObj) {
    return new Promise((resolve, reject) => {
      module.exports.get_token_utxos(queryObj, (response) => {
        resolve(response);
      });
    });
  },

  get_token_balance: function (queryObj, cb) {
    rpcCommand([{ method: 'getaddressbalance', parameters: [queryObj, true] }], function (response) {
      return cb(response);
    });
  },

  get_token_balance_promise: function (queryObj) {
    return new Promise((resolve, reject) => {
      module.exports.get_token_balance(queryObj, (response) => {
        resolve(response);
      });
    });
  },

  get_rawtransaction: function (hash, cb, verbose = 1) {
    if (settings.use_rpc) {
      rpcCommand([{ method: 'getrawtransaction', parameters: [hash, verbose] }], function (response) {
        return cb(response);
      });
    } else {
      var uri = base_url + 'getrawtransaction?txid=' + hash + '&decrypt=' + verbose;
      request({ uri: uri, json: true }, function (error, response, body) {
        return cb(body);
      });
    }
  },

  get_rawtransaction_promise: function (hash, verbose = 1) {
    return new Promise((resolve, reject) => {
      module.exports.get_rawtransaction(
        hash,
        (response) => {
          resolve(response);
        },
        verbose
      );
    });
  },

  get_maxmoney: function (cb) {
    if (settings.use_rpc) {
      rpcCommand([{ method: 'getmaxmoney', parameters: [] }], function (response) {
        return cb(response);
      });
    } else {
      var uri = base_url + 'getmaxmoney';
      request({ uri: uri, json: true }, function (error, response, body) {
        return cb(body);
      });
    }
  },

  get_maxvote: function (cb) {
    if (settings.use_rpc) {
      rpcCommand([{ method: 'getmaxvote', parameters: [] }], function (response) {
        return cb(response);
      });
    } else {
      var uri = base_url + 'getmaxvote';
      request({ uri: uri, json: true }, function (error, response, body) {
        return cb(body);
      });
    }
  },

  get_vote: function (cb) {
    if (settings.use_rpc) {
      client.command([{ method: 'getvote', parameters: [] }], function (err, response) {
        if (err) {
          console.log('Error: ', err);
        } else {
          if (response[0].name == 'RpcError') {
            return cb('There was an error. Check your console.');
          }
          return cb(response[0]);
        }
      });
    } else {
      var uri = base_url + 'getvote';
      request({ uri: uri, json: true }, function (error, response, body) {
        return cb(body);
      });
    }
  },

  get_phase: function (cb) {
    if (settings.use_rpc) {
      client.command([{ method: 'getphase', parameters: [] }], function (err, response) {
        if (err) {
          console.log('Error: ', err);
        } else {
          if (response[0].name == 'RpcError') {
            return cb('There was an error. Check your console.');
          }
          return cb(response[0]);
        }
      });
    } else {
      var uri = base_url + 'getphase';
      request({ uri: uri, json: true }, function (error, response, body) {
        return cb(body);
      });
    }
  },

  get_reward: function (cb) {
    if (settings.use_rpc) {
      client.command([{ method: 'getreward', parameters: [] }], function (err, response) {
        if (err) {
          console.log('Error: ', err);
        } else {
          if (response[0].name == 'RpcError') {
            return cb('There was an error. Check your console.');
          }
          return cb(response[0]);
        }
      });
    } else {
      var uri = base_url + 'getreward';
      request({ uri: uri, json: true }, function (error, response, body) {
        return cb(body);
      });
    }
  },

  get_estnext: function (cb) {
    if (settings.use_rpc) {
      client.command([{ method: 'getnextrewardestimate', parameters: [] }], function (err, response) {
        if (err) {
          console.log('Error: ', err);
        } else {
          if (response[0].name == 'RpcError') {
            return cb('There was an error. Check your console.');
          }
          return cb(response[0]);
        }
      });
    } else {
      var uri = base_url + 'getnextrewardestimate';
      request({ uri: uri, json: true }, function (error, response, body) {
        return cb(body);
      });
    }
  },

  get_nextin: function (cb) {
    if (settings.use_rpc) {
      client.command([{ method: 'getnextrewardwhenstr', parameters: [] }], function (err, response) {
        if (err) {
          console.log('Error: ', err);
        } else {
          if (response[0].name == 'RpcError') {
            return cb('There was an error. Check your console.');
          }
          return cb(response[0]);
        }
      });
    } else {
      var uri = base_url + 'getnextrewardwhenstr';
      request({ uri: uri, json: true }, function (error, response, body) {
        return cb(body);
      });
    }
  },

  // synchonous loop used to interate through an array,
  // avoid use unless absolutely neccessary
  syncLoop: function (iterations, process, exit) {
    var index = 0,
      done = false,
      shouldExit = false;
    var loop = {
      next: function () {
        if (done) {
          if (shouldExit && exit) {
            exit(); // Exit if we're done
          }
          return; // Stop the loop if we're done
        }
        // If we're not finished
        if (index < iterations) {
          index++; // Increment our index
          if (index % 100 === 0) {
            //clear stack
            setTimeout(function () {
              process(loop); // Run our process, pass in the loop
            }, 1);
          } else {
            process(loop); // Run our process, pass in the loop
          }
          // Otherwise we're done
        } else {
          done = true; // Make sure we say we're done
          if (exit) exit(); // Call the callback on exit
        }
      },
      iteration: function () {
        return index - 1; // Return the loop number we're on
      },
      break: function (end) {
        done = true; // End the loop
        shouldExit = end; // Passing end as true means we still call the exit callback
      },
    };
    loop.next();
    return loop;
  },

  balance_supply: function (cb) {
    Address.find({}, 'balance')
      .where('balance')
      .gt(0)
      .exec(function (err, docs) {
        var count = 0;
        module.exports.syncLoop(
          docs.length,
          function (loop) {
            var i = loop.iteration();
            count = count + docs[i].balance;
            loop.next();
          },
          function () {
            return cb(count);
          }
        );
      });
  },

  get_supply: function (cb) {
    if (settings.use_rpc) {
      if (settings.supply == 'HEAVY') {
        client.command([{ method: 'getsupply', parameters: [] }], function (err, response) {
          if (err) {
            console.log('Error: ', err);
          } else {
            if (response[0].name == 'RpcError') {
              return cb('There was an error. Check your console.');
            }
            return cb(response[0]);
          }
        });
      } else if (settings.supply == 'GETINFO') {
        client.command([{ method: 'getinfo', parameters: [] }], function (err, response) {
          if (err) {
            console.log('Error: ', err);
          } else {
            if (response[0].name == 'RpcError') {
              return cb('There was an error. Check your console.');
            }
            return cb(response[0].moneysupply);
          }
        });
      } else if (settings.supply == 'BALANCES') {
        module.exports.balance_supply(function (supply) {
          return cb(supply / 1000000);
        });
      } else if (settings.supply == 'TXOUTSET') {
        client.command([{ method: 'gettxoutsetinfo', parameters: [] }], function (err, response) {
          if (err) {
            console.log('Error: ', err);
          } else {
            if (response[0].name == 'RpcError') {
              return cb('There was an error. Check your console.');
            }
            return cb(response[0].total_amount);
          }
        });
      } else {
        coinbase_supply(function (supply) {
          return cb(supply / 1000000);
        });
      }
    } else {
      if (settings.supply == 'HEAVY') {
        var uri = base_url + 'getsupply';
        request({ uri: uri, json: true }, function (error, response, body) {
          return cb(body);
        });
      } else if (settings.supply == 'GETINFO') {
        var uri = base_url + 'getinfo';
        request({ uri: uri, json: true }, function (error, response, body) {
          return cb(body.moneysupply);
        });
      } else if (settings.supply == 'BALANCES') {
        module.exports.balance_supply(function (supply) {
          return cb(supply / 1000000);
        });
      } else if (settings.supply == 'TXOUTSET') {
        var uri = base_url + 'gettxoutsetinfo';
        request({ uri: uri, json: true }, function (error, response, body) {
          return cb(body.total_amount);
        });
      } else {
        coinbase_supply(function (supply) {
          return cb(supply / 1000000);
        });
      }
    }
  },

  is_unique: function (array, object, cb) {
    var unique = true;
    var index = null;
    module.exports.syncLoop(
      array.length,
      function (loop) {
        var i = loop.iteration();
        if (array[i].addresses == object) {
          unique = false;
          index = i;
          loop.break(true);
          loop.next();
        } else {
          loop.next();
        }
      },
      function () {
        return cb(unique, index);
      }
    );
  },

  calculate_total: function (vout, cb) {
    var total = 0;
    module.exports.syncLoop(
      vout.length,
      function (loop) {
        var i = loop.iteration();
        //module.exports.convert_to_satoshi(parseFloat(vout[i].amount), function(amount_sat){
        total = total + vout[i].amount;
        loop.next();
        //});
      },
      function () {
        return cb(total);
      }
    );
  },

  prepare_vout: function (vout, blockhash, vin, cb) {
    var arr_vout = [];
    var arr_vin = [];
    arr_vin = vin;
    var block = {};
    module.exports.syncLoop(
      vout.length,
      async function (loop) {
        var i = loop.iteration();
        // make sure vout has an address
        if (vout[i].scriptPubKey.type != 'nonstandard' && vout[i].scriptPubKey.type != 'nulldata') {
          // check if vout address is unique, if so add it array, if not add its amount to existing index
          //console.log('vout:' + i + ':' + txid);

          // Prepare timelock info
          var result = await module.exports.get_timelockutxoinfo(vout[i], block, blockhash);
          block = result.block;

          module.exports.convert_to_satoshi(parseFloat(vout[i].value), function (amount_sat) {
            arr_vout.push({
              addresses: vout[i].scriptPubKey.addresses[0],
              amount: amount_sat,
              timelockUtxoInfo: result.timelockUtxoInfo,
            });
            loop.next();
          });
        } else {
          // no address, move to next vout
          loop.next();
        }
      },
      function () {
        if (vout[0].scriptPubKey.type == 'nonstandard') {
          if (arr_vin.length > 0 && arr_vout.length > 0) {
            if (arr_vin[0].addresses == arr_vout[0].addresses) {
              //PoS
              arr_vout[0].amount = arr_vout[0].amount - arr_vin[0].amount;
              arr_vin.shift();
              return cb(arr_vout, arr_vin);
            } else {
              return cb(arr_vout, arr_vin);
            }
          } else {
            return cb(arr_vout, arr_vin);
          }
        } else {
          return cb(arr_vout, arr_vin);
        }
      }
    );
  },

  get_input_addresses: function (input, vout, cb) {
    var addresses = [];
    if (input.coinbase) {
      var amount = 0;
      module.exports.syncLoop(
        vout.length,
        function (loop) {
          var i = loop.iteration();
          amount = amount + parseFloat(vout[i].value);
          loop.next();
        },
        function () {
          addresses.push({ hash: 'coinbase', amount: amount });
          return cb(addresses);
        }
      );
    } else {
      module.exports.get_rawtransaction(input.txid, function (prevTx) {
        if (prevTx) {
          module.exports.syncLoop(
            prevTx.vout.length,
            function (loop) {
              var i = loop.iteration();
              if (prevTx.vout[i].n == input.vout) {
                //module.exports.convert_to_satoshi(parseFloat(prevTx.vout[i].value), function(amount_sat){
                if (prevTx.vout[i].scriptPubKey.addresses) {
                  addresses.push({ hash: prevTx.vout[i].scriptPubKey.addresses[0], amount: prevTx.vout[i].value });
                }
                loop.break(true);
                loop.next();
                //});
              } else {
                loop.next();
              }
            },
            function () {
              return cb(addresses);
            }
          );
        } else {
          return cb();
        }
      });
    }
  },

  prepare_vin: function (tx, cb) {
    var arr_vin = [];
    module.exports.syncLoop(
      tx.vin.length,
      function (loop) {
        var i = loop.iteration();
        module.exports.get_input_addresses(tx.vin[i], tx.vout, function (addresses) {
          // return an element {vin_address, sent_amount}
          if (addresses && addresses.length) {
            //console.log('vin');
            module.exports.convert_to_satoshi(parseFloat(addresses[0].amount), function (amount_sat) {
              arr_vin.push({
                addresses: addresses[0].hash,
                amount: amount_sat,
                prevTxid: tx.vin[i].txid,
                prevVout: tx.vin[i].vout,
              }); // TODO: need to add vout
              loop.next();
            });
          } else {
            loop.next();
          }
        });
      },
      function () {
        return cb(arr_vin);
      }
    );
  },
};
