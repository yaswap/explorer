var mongoose = require('mongoose'),
  Stats = require('../models/stats'),
  Markets = require('../models/markets'),
  Address = require('../models/address'),
  AddressTx = require('../models/addresstx'),
  { TimelockUtxoInfo, AddressUtxo } = require('../models/addressutxo'),
  AddressUtxoMempool = require('../models/addressutxomempool'),
  Tx = require('../models/tx'),
  Richlist = require('../models/richlist'),
  TimeLock = require('../models/timelock'),
  Block = require('../models/block'),
  Peers = require('../models/peers'),
  Heavy = require('../models/heavy'),
  lib = require('./explorer'),
  settings = require('./settings'),
  fs = require('fs'),
  async = require('async');

mongoose.set('useCreateIndex', true);
mongoose.set('useUnifiedTopology', true);
mongoose.set('useNewUrlParser', true);
mongoose.set('useFindAndModify', false);

const util = require('util');

function find_address(hash, cb) {
  Address.findOne({ a_id: hash }, function (err, address) {
    if (address) {
      return cb(address);
    } else {
      return cb();
    }
  });
}

function find_utxo_mempool(blockheight, address, cb) {
  AddressUtxoMempool.find({ blockheight: blockheight, a_id: address }, function (err, utxos) {
    if (utxos.length > 0) {
      result = utxos.filter(function (utxo) {
        return utxo.isused === false;
      });
      return cb(true, result);
    } else {
      return cb(false);
    }
  });
}

function find_utxo(address, cb) {
  AddressUtxo.find({ a_id: address, isused: false }, function (err, utxo) {
    return cb(utxo);
  });
}

function find_address_tx(address, hash, cb) {
  AddressTx.findOne({ a_id: address, txid: hash }, function (err, address_tx) {
    if (address_tx) {
      return cb(address_tx);
    } else {
      return cb();
    }
  });
}

function find_richlist(coin, cb) {
  Richlist.findOne({ coin: coin }, function (err, richlist) {
    if (richlist) {
      return cb(richlist);
    } else {
      return cb();
    }
  });
}

function find_timelock(redeemscript, cb) {
  TimeLock.findOne({ redeemscript: redeemscript }, function (err, timelock) {
    if (timelock) {
      return cb(timelock);
    } else {
      return cb();
    }
  });
}

// hash = address
async function update_address_mempool(hash, block_height, tx, amount, type, tx_info, cb) {
  var to_sent = false;
  var to_received = false;
  var addr_inc = {};

  // Initialize AddressUtxoMempool db
  await AddressUtxoMempool.findOne({
    blockheight: block_height,
    a_id: hash,
  })
    .exec()
    .then(async function (utxos) {
      if (!utxos) {
        await AddressUtxo.find({ a_id: hash })
          .exec()
          .then(async function (utxo) {
            for (var i = 0; i < utxo.length; i++) {
              await Tx.findOne({ txid: utxo[i].txid })
                .exec()
                .then(async function (tx) {
                  var blockutxoheight = block_height;
                  if (tx) {
                    blockutxoheight = tx.blockindex;
                  }
                  var newAddressUtxoMempool = new AddressUtxoMempool({
                    blockheight: block_height,
                    a_id: hash,
                    blockutxoheight: blockutxoheight,
                    txid: utxo[i].txid,
                    vout: utxo[i].vout,
                    isused: utxo[i].isused,
                    amount: utxo[i].amount,
                    timelockinfo: utxo[i].timelockinfo,
                  });
                  await newAddressUtxoMempool.save();
                });
            }
          });
      }
    });

  if (type == 'vin') {
    addr_inc.sent = amount;
    addr_inc.balance = -amount;
    // There must be some UTXOs are used
    await AddressUtxoMempool.findOneAndUpdate(
      { blockheight: block_height, a_id: hash, txid: tx_info.prevTxid, vout: tx_info.prevVout },
      {
        $set: {
          isused: true,
        },
      },
      {
        new: true, // return the modified document rather than the original
      }
    ).exec();
  } else {
    addr_inc.received = amount;
    addr_inc.balance = amount;
    // There are new UTXOs
    var newAddressUtxoMempool = new AddressUtxoMempool({
      blockheight: block_height,
      a_id: hash,
      blockutxoheight: block_height,
      txid: tx.txid,
      vout: tx_info.curVout,
      isused: false,
      amount: amount,
      timelockinfo: tx_info.timelockUtxoInfo,
    });
    await newAddressUtxoMempool.save();
  }
  return cb();
}

// hash = address
function update_utxo(hash, txid, amount, type, tx_info, cb) {
  var addr_inc = {};
  if (hash == 'coinbase') {
    // it must by type = 'vin'
    addr_inc.sent = amount;
  } else {
    if (type == 'vin') {
      addr_inc.sent = amount;
      addr_inc.balance = -amount;
      // There must be some UTXOs are used
      AddressUtxo.findOneAndUpdate(
        { a_id: hash, txid: tx_info.prevTxid, vout: tx_info.prevVout },
        {
          $set: {
            isused: true,
          },
        },
        {
          new: true, // return the modified document rather than the original
        }
      ).exec(function () {
        return cb();
      });
    } else {
      addr_inc.received = amount;
      addr_inc.balance = amount;
      // There are new UTXOs
      AddressUtxo.findOne({ txid: txid }, function (err, result) {
        if (!result) {
          var newAddressUtxo = new AddressUtxo({
            a_id: hash,
            txid: txid,
            vout: tx_info.curVout,
            isused: false,
            amount: amount,
          });
          newAddressUtxo.save(function () {
            return cb();
          });
        } else {
          return cb();
        }
      });
    }
  }
}

// hash = address
async function update_address(hash, blockheight, tx, amount, type, tx_info, cb) {
  /*
    tx_info is an object
    {
      prevTxid: nvin[i].prevTxid, // type = vin
      prevVout: nvin[i].prevVout, // type = vin
      curVout: null,  // type = vout
      timelockUtxoInfo: vout[t].timelockUtxoInfo, // type = vout
    }
  */
  var addr_inc = {};
  if (hash == 'coinbase') {
    // it must by type = 'vin'
    addr_inc.sent = amount;
  } else {
    if (type == 'vin') {
      addr_inc.sent = amount;
      addr_inc.balance = -amount;
      // There must be some UTXOs are used
      const utxo = await AddressUtxo.findOneAndUpdate(
        { a_id: hash, txid: tx_info.prevTxid, vout: tx_info.prevVout },
        {
          $set: {
            isused: true,
          },
        },
        {
          new: true, // return the modified document rather than the original
        }
      );
    } else {
      addr_inc.received = amount;
      addr_inc.balance = amount;
      // There are new UTXOs
      var newAddressUtxo = new AddressUtxo({
        a_id: hash,
        txid: tx.txid,
        vout: tx_info.curVout,
        isused: false,
        amount: amount,
        timelockinfo: tx_info.timelockUtxoInfo,
      });
      await newAddressUtxo.save();
    }
  }
  // Update (or create new document) sent, received, balance of an address
  try {
    const address = await Address.findOneAndUpdate(
      { a_id: hash },
      {
        $inc: addr_inc,
      },
      {
        new: true, // return the modified document rather than the original
        upsert: true, // creates the object if it doesn't exist. defaults to false.
      }
    );

    if (hash === 'coinbase') {
      return cb();
    }

    // Update (or create new document) transaction of an address
    const addresstx = await AddressTx.findOneAndUpdate(
      { a_id: hash, txid: tx.txid },
      {
        $inc: {
          amount: addr_inc.balance,
        },
        $set: {
          a_id: hash,
          blockindex: blockheight,
          txid: tx.txid,
        },
      },
      {
        new: true,
        upsert: true,
      }
    );
    return cb();
  } catch (err) {
    return cb(err);
  }
}

function find_tx(txid, cb) {
  Tx.findOne({ txid: txid }, function (err, tx) {
    if (tx) {
      return cb(tx);
    } else {
      return cb(null);
    }
  });
}

function save_tx_mempool(txid, block_height, cb) {
  //var s_timer = new Date().getTime();
  lib.get_rawtransaction(txid, function (tx) {
    // Refer tx format http://explorer.yacoin.org/api/getrawtransaction?txid=51e24109397d06376fd61e50d9d59b4164d6a41bf64fcf959bdd79077f61e2ca&decrypt=1
    if (tx != 'There was an error. Check your console.') {
      // prepare list of {vin_address, sent_amount, prevTxid, prevVout}
      lib.prepare_vin(tx, function (vin) {
        // prepare list of {vout_address, received_amount, timelockUtxoInfo}
        lib.prepare_vout(tx.vout, tx.blockhash, vin, function (vout, nvin) {
          // nvin is nearly same as vin, only different for PoS block
          /*
          nvin is list of
          [
            {
              addresses: addresses[0].hash,
              amount: amount_sat,
              prevTxid: tx.vin[i].txid,
              prevVout: tx.vin[i].vout,
            };
          ]

          vout is list of
          [
            {
              addresses: vout[i].scriptPubKey.addresses[0],
              amount: amount_sat,
              timelockUtxoInfo: timelockUtxoInfo,
            }
          ]

          */
          lib.syncLoop(
            vin.length,
            function (loop) {
              // Update balance and transaction of addresses used as vin
              var i = loop.iteration();
              tx_info = {
                prevTxid: nvin[i].prevTxid,
                prevVout: nvin[i].prevVout,
                curVout: null,
                timelockUtxoInfo: null,
              };
              update_address_mempool(nvin[i].addresses, block_height, tx, nvin[i].amount, 'vin', tx_info, function () {
                loop.next();
              });
            },
            function () {
              lib.syncLoop(
                vout.length,
                function (subloop) {
                  var t = subloop.iteration();
                  if (vout[t].addresses) {
                    // Update balance and transaction of addresses in vout
                    tx_info = {
                      prevTxid: null,
                      prevVout: null,
                      curVout: t,
                      timelockUtxoInfo: vout[t].timelockUtxoInfo,
                    };
                    update_address_mempool(
                      vout[t].addresses,
                      block_height,
                      tx,
                      vout[t].amount,
                      'vout',
                      tx_info,
                      function () {
                        subloop.next();
                      }
                    );
                  } else {
                    subloop.next();
                  }
                },
                function () {
                  return cb();
                }
              );
            }
          );
        });
      });
    } else {
      return cb('tx not found: ' + txid);
    }
  });
}

function reindex_tx(txid, cb) {
  //var s_timer = new Date().getTime();
  lib.get_rawtransaction(txid, function (tx) {
    // Refer tx format http://explorer.yacoin.org/api/getrawtransaction?txid=51e24109397d06376fd61e50d9d59b4164d6a41bf64fcf959bdd79077f61e2ca&decrypt=1
    if (tx != 'There was an error. Check your console.') {
      lib.prepare_vin(tx, function (vin) {
        // prepare list of {vin_address, sent_amount}
        lib.prepare_vout(tx.vout, tx.blockhash, vin, function (vout, nvin) {
          // prepare list of {vout_address, received_amount}
          lib.syncLoop(
            vin.length,
            function (loop) {
              // Update balance and transaction of addresses used as vin
              var i = loop.iteration();
              tx_info = {
                prevTxid: nvin[i].prevTxid,
                prevVout: nvin[i].prevVout,
                curVout: null,
              };
              update_utxo(nvin[i].addresses, txid, nvin[i].amount, 'vin', tx_info, function () {
                loop.next();
              });
            },
            function () {
              lib.syncLoop(
                vout.length,
                function (subloop) {
                  var t = subloop.iteration();
                  if (vout[t].addresses) {
                    // Update balance and transaction of addresses in vout
                    tx_info = {
                      prevTxid: null,
                      prevVout: null,
                      curVout: t,
                    };
                    update_utxo(vout[t].addresses, txid, vout[t].amount, 'vout', tx_info, function () {
                      subloop.next();
                    });
                  } else {
                    subloop.next();
                  }
                },
                function () {
                  return cb();
                }
              );
            }
          );
        });
      });
    } else {
      return cb('tx not found: ' + txid);
    }
  });
}

async function save_tx_promise(txid, block) {
  return new Promise((resolve, reject) => {
    save_tx(txid, block, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

function save_tx(txid, block, cb) {
  //var s_timer = new Date().getTime();
  lib.get_rawtransaction(txid, function (tx) {
    // Refer tx format http://explorer.yacoin.org/api/getrawtransaction?txid=51e24109397d06376fd61e50d9d59b4164d6a41bf64fcf959bdd79077f61e2ca&decrypt=1
    if (tx != 'There was an error. Check your console.') {
      // prepare list of {vin_address, sent_amount, prevTxid, prevVout}
      lib.prepare_vin(tx, function (vin) {
        // prepare list of {vout_address, received_amount, timelockUtxoInfo}
        lib.prepare_vout(tx.vout, tx.blockhash, vin, function (vout, nvin) {
          // nvin is nearly same as vin, only different for PoS block
          /*
          nvin is list of
          [
            {
              addresses: addresses[0].hash,
              amount: amount_sat,
              prevTxid: tx.vin[i].txid,
              prevVout: tx.vin[i].vout,
            };
          ]

          vout is list of
          [
            {
              addresses: vout[i].scriptPubKey.addresses[0],
              amount: amount_sat,
              timelockUtxoInfo: timelockUtxoInfo,
            }
          ]

          */
          lib.syncLoop(
            vin.length,
            function (loop) {
              // Update balance and transaction of addresses used as vin
              var i = loop.iteration();
              tx_info = {
                prevTxid: nvin[i].prevTxid,
                prevVout: nvin[i].prevVout,
                curVout: null,
                timelockUtxoInfo: null,
              };
              update_address(nvin[i].addresses, block.height, tx, nvin[i].amount, 'vin', tx_info, function () {
                loop.next();
              });
            },
            function () {
              lib.syncLoop(
                vout.length,
                function (subloop) {
                  var t = subloop.iteration();
                  if (vout[t].addresses) {
                    // Update balance and transaction of addresses in vout
                    tx_info = {
                      prevTxid: null,
                      prevVout: null,
                      curVout: t,
                      timelockUtxoInfo: vout[t].timelockUtxoInfo,
                    };
                    update_address(vout[t].addresses, block.height, tx, vout[t].amount, 'vout', tx_info, function () {
                      subloop.next();
                    });
                  } else {
                    subloop.next();
                  }
                },
                async function () {
                  // Update timelock info
                  var timelocklist = await TimeLock.find({});
                  for (var item of timelocklist) {
                    var total_timelocked_utxo_value = 0;
                    var utxos = await AddressUtxo.find({ a_id: item.a_id, isused: false, timelockinfo: { $ne: null } });

                    for (var utxo of utxos) {
                      /*
                        utxoinfo = {
                          amount: utxo.amount,
                          timetouse_string: utxo.timetouse_string,
                        }
                      */
                      if (utxo.timelockinfo.isexpired) {
                        continue;
                      }

                      // Check if the timelocked UTXO was expired
                      var isexpired = false;
                      if (utxo.timelockinfo.istimebased && utxo.timelockinfo.timetouse_number <= block.time) {
                        isexpired = true;
                      } else if (!utxo.timelockinfo.istimebased && utxo.timelockinfo.timetouse_number <= block.height) {
                        isexpired = true;
                      }

                      if (isexpired) {
                        // Mark the timelocked UTXO as expired
                        await AddressUtxo.findOneAndUpdate(
                          { a_id: utxo.a_id, txid: utxo.txid, vout: utxo.vout },
                          {
                            $set: {
                              'timelockinfo.isexpired': true,
                            },
                          }
                        );
                      } else {
                        total_timelocked_utxo_value += utxo.amount;
                      }
                    }

                    // Update balance of timelock address
                    if (total_timelocked_utxo_value !== item.balance) {
                      await TimeLock.findOneAndUpdate(
                        { a_id: item.a_id },
                        {
                          $set: {
                            balance: total_timelocked_utxo_value,
                          },
                        }
                      );
                    }
                  }

                  // Create new document about tx
                  lib.calculate_total(vout, async function (total) {
                    try {
                      var newTx = new Tx({
                        txid: tx.txid,
                        vin: nvin, // array of {vin_address, sent_amount, prevTxid, prevVout}
                        vout: vout, // array of {vout_address, received_amount, timelockUtxoInfo}
                        total: total.toFixed(8), // total value of vout
                        timestamp: tx.time,
                        blockhash: tx.blockhash,
                        blockindex: block.height,
                        blocktime: block.time,
                      });
                      await newTx.save();

                      return cb();
                    } catch (err) {
                      return cb(err);
                    }
                  });
                }
              );
            }
          );
        });
      });
    } else {
      return cb('tx not found: ' + txid);
    }
  });
}

function get_market_data(market, cb) {
  if (fs.existsSync('./lib/markets/' + market + '.js')) {
    exMarket = require('./markets/' + market);
    exMarket.get_data(settings.markets, function (err, obj) {
      return cb(err, obj);
    });
  } else {
    return cb(null);
  }
}

function create_lock(lockfile, cb) {
  if (settings.lock_during_index == true) {
    var fname = './tmp/' + lockfile + '.pid';
    fs.appendFile(fname, process.pid.toString(), function (err) {
      if (err) {
        console.log('Error: unable to create %s', fname);
        process.exit(1);
      } else {
        return cb();
      }
    });
  } else {
    return cb();
  }
}

function remove_lock(lockfile, cb) {
  if (settings.lock_during_index == true) {
    var fname = './tmp/' + lockfile + '.pid';
    fs.unlink(fname, function (err) {
      if (err) {
        console.log('unable to remove lock: %s', fname);
        process.exit(1);
      } else {
        return cb();
      }
    });
  } else {
    return cb();
  }
}

function is_locked(lockfile, cb) {
  if (settings.lock_during_index == true) {
    var fname = './tmp/' + lockfile + '.pid';
    fs.exists(fname, function (exists) {
      if (exists) {
        return cb(true);
      } else {
        return cb(false);
      }
    });
  } else {
    return cb(false);
  }
}

module.exports = {
  // initialize DB
  connect: function (database, cb) {
    mongoose.connect(database, function (err) {
      if (err) {
        console.log('Unable to connect to database: %s', database);
        console.log('Aborting');
        process.exit(1);
      }
      //console.log('Successfully connected to MongoDB');
      return cb();
    });
  },

  is_locked: function (cb) {
    is_locked('db_index', function (exists) {
      if (exists) {
        return cb(true);
      } else {
        return cb(false);
      }
    });
  },

  update_label: function (hash, message, cb) {
    find_address(hash, function (address) {
      if (address) {
        Address.updateOne(
          { a_id: hash },
          {
            name: message,
          },
          function () {
            return cb();
          }
        );
      }
    });
  },

  check_stats: function (coin, cb) {
    Stats.findOne({ coin: coin }, function (err, stats) {
      if (stats) {
        return cb(true);
      } else {
        return cb(false);
      }
    });
  },

  get_stats: function (coin, cb) {
    Stats.findOne({ coin: coin }, function (err, stats) {
      if (stats) {
        return cb(stats);
      } else {
        return cb(null);
      }
    });
  },

  update_password: function (newpassword, cb) {
    Stats.updateOne(
      { coin: settings.coin },
      {
        $set: { admin_password: newpassword },
      },
      function (err, stats) {
        return cb(err);
      }
    );
  },

  update_price: function (newprice, cb) {
    Stats.updateOne(
      { coin: settings.coin },
      {
        last_price: newprice,
      },
      function (err, stats) {
        return cb(err);
      }
    );
  },

  create_stats: function (coin, cb) {
    var newStats = new Stats({
      coin: coin,
      last: 0,
      admin_password: 'admin',
    });

    newStats.save(function (err) {
      if (err) {
        console.log(err);
        return cb();
      } else {
        console.log('initial stats entry created for %s', coin);
        //console.log(newStats);
        return cb();
      }
    });
  },

  get_blocktime: async function (blockheight) {
    const blockinDB = await Block.findOne({ blockheight: blockheight });
    return blockinDB.blocktime;
  },

  get_address: function (hash, cb) {
    find_address(hash, function (address) {
      return cb(address);
    });
  },

  get_richlist: function (coin, cb) {
    find_richlist(coin, function (richlist) {
      return cb(richlist);
    });
  },

  get_timelock: function (redeemscript, cb) {
    find_timelock(redeemscript, function (timelock) {
      return cb(timelock);
    });
  },

  get_timelockinfo: async function () {
    var timelockinfo = [];
    var timelocklist = await TimeLock.find({ balance: { $gt: 0 } })
      .sort({ balance: 'desc' })
      .limit(100);

    for (var item of timelocklist) {
      var info = {
        address: item.a_id,
        redeemscript: item.redeemscript,
        description: item.description,
        balance: 0,
        timelockedbalance: item.balance,
        type: item.type,
        utxos: [],
      };

      var address = await Address.findOne({ a_id: item.a_id });
      info.balance += address.balance;

      var utxos = await AddressUtxo.find({ a_id: item.a_id, isused: false, timelockinfo: { $ne: null } })
        .sort({ amount: 'desc' })
        .limit(10);
      for (var utxo of utxos) {
        /*
          utxoinfo = {
            amount: utxo.amount,
            timetouse_string: utxo.timetouse_string,
          }
        */
        // Exclude the timelocked UTXO was expired
        if (utxo.timelockinfo.isexpired) {
          continue;
        }

        info.utxos.push({
          amount: utxo.amount,
          timetouse_string: utxo.timelockinfo.timetouse_string,
        });
      }

      timelockinfo.push(info);
    }

    return timelockinfo;
  },

  get_utxo_mempool: function (blockheight, address, cb) {
    find_utxo_mempool(blockheight, address, function (found, utxo) {
      return cb(found, utxo);
    });
  },

  get_utxo: function (address, cb) {
    find_utxo(address, function (utxo) {
      return cb(utxo);
    });
  },

  get_utxo_mempool_info: function (blockheight, address, cb) {
    utxo_mempool_info = {
      funded_txo_count: 0,
      funded_txo_sum: 0,
      spent_txo_count: 0,
      spent_txo_sum: 0,
    };
    new_txcount = 0;
    AddressUtxoMempool.find({ blockheight: blockheight, a_id: address }, function (err, funded_txo_mempool) {
      if (funded_txo_mempool.length > 0) {
        funded_txo_mempool.forEach(function (txo) {
          utxo_mempool_info.funded_txo_count++;
          utxo_mempool_info.funded_txo_sum += txo.amount;
          if (txo.isused) {
            utxo_mempool_info.spent_txo_count++;
            utxo_mempool_info.spent_txo_sum += txo.amount;
          }
          if (txo.blockutxoheight == blockheight) {
            new_txcount++;
          }
        });
        return cb(utxo_mempool_info, new_txcount);
      } else {
        return cb();
      }
    });
  },

  get_utxo_info: function (address, cb) {
    utxo_info = {
      funded_txo_count: 0,
      funded_txo_sum: 0,
      spent_txo_count: 0,
      spent_txo_sum: 0,
    };
    AddressUtxo.find({ a_id: address }, function (err, funded_txo) {
      if (funded_txo.length > 0) {
        utxo_info = funded_txo.reduce(function (acc, txo) {
          acc.funded_txo_count++;
          acc.funded_txo_sum += txo.amount;
          if (txo.isused) {
            acc.spent_txo_count++;
            acc.spent_txo_sum += txo.amount;
          }
          return acc;
        }, utxo_info);
      }
      return cb(utxo_info);
    });
  },

  get_txcount: function (address, cb) {
    AddressTx.find({ a_id: address }).count(function (err, count) {
      if (err) {
        return cb(0);
      } else {
        return cb(count);
      }
    });
  },

  add_P2SH_timelock: function (describeinfo, cb) {
    // Prepare new document
    var newTimeLock = new TimeLock({ redeemscript: describeinfo.RedeemScriptHex });
    newTimeLock.locktime = parseInt(
      describeinfo.RedeemScriptFormat.substr(0, describeinfo.RedeemScriptFormat.indexOf(' '))
    );
    var opcodeStr = '';
    var lockCondition = '';

    if (describeinfo.RedeemScriptFormat.includes('OP_CHECKLOCKTIMEVERIFY')) {
      opcodeStr = 'OP_CHECKLOCKTIMEVERIFY opcode';
      newTimeLock.a_id = describeinfo.CltvAddress;

      if (newTimeLock.locktime < lib.CLTV_LOCKTIME_THRESHOLD) {
        // Block-based lock
        newTimeLock.type = lib.ScriptPubKeyType.CLTV_P2SH_timelock_blockbased;
        lockCondition += 'locked until block height ' + newTimeLock.locktime;
      } else {
        // Time-based lock
        newTimeLock.type = lib.ScriptPubKeyType.CLTV_P2SH_timelock_timebased;
        const date = new Date(newTimeLock.locktime * 1000);
        lockCondition += 'locked until ' + date.toLocaleString();
      }
    } else {
      opcodeStr = 'OP_CHECKSEQUENCEVERIFY opcode';
      newTimeLock.a_id = describeinfo.CsvAddress;
      if (newTimeLock.locktime & lib.SEQUENCE_LOCKTIME_TYPE_FLAG) {
        // Time-based lock
        // Convert to real seconds
        newTimeLock.locktime = (newTimeLock.locktime & lib.SEQUENCE_LOCKTIME_MASK) << lib.SEQUENCE_LOCKTIME_GRANULARITY;
        newTimeLock.type = lib.ScriptPubKeyType.CSV_P2SH_timelock_timebased;
        lockCondition += 'locked for a period of ' + newTimeLock.locktime + ' seconds';
      } else {
        // Block-based lock
        newTimeLock.type = lib.ScriptPubKeyType.CSV_P2SH_timelock_blockbased;
        lockCondition += 'locked within ' + newTimeLock.locktime + ' blocks';
      }
    }
    newTimeLock.description =
      'This address uses ' + opcodeStr + '. Any coins sent to this address will be ' + lockCondition;

    find_address(newTimeLock.a_id, async function (address) {
      // Update current balance of P2SH timelock address
      if (address) {
        newTimeLock.balance = address.balance;
      }

      // Save document
      await newTimeLock.save();

      // CLTV
      if (describeinfo.RedeemScriptFormat.includes('OP_CHECKLOCKTIMEVERIFY')) {
        // Prepare TimelockUtxoInfo
        var newTimeLockUtxoInfo = new TimelockUtxoInfo();
        newTimeLockUtxoInfo.iscltv = true;
        newTimeLockUtxoInfo.locktime = newTimeLock.locktime;
        newTimeLockUtxoInfo.timetouse_number = newTimeLockUtxoInfo.locktime;

        if (newTimeLock.type === lib.ScriptPubKeyType.CLTV_P2SH_timelock_timebased) {
          newTimeLockUtxoInfo.istimebased = true;
          const date = new Date(newTimeLockUtxoInfo.timetouse_number * 1000);
          newTimeLockUtxoInfo.timetouse_string += 'unlock at ' + date.toLocaleString();
        } else {
          newTimeLockUtxoInfo.istimebased = false;
          newTimeLockUtxoInfo.timetouse_string += 'unlock at block height ' + newTimeLockUtxoInfo.timetouse_number;
        }

        await AddressUtxo.updateMany(
          { a_id: newTimeLock.a_id },
          {
            $set: {
              timelockinfo: newTimeLockUtxoInfo,
            },
          }
        );
        // CSV
      } else {
        // Update timelockinfo for addressutxo of csv address
        const utxos = await AddressUtxo.find({ a_id: newTimeLock.a_id });
        for (var i = 0; i < utxos.length; i++) {
          const utxo = utxos[i];
          // Prepare TimelockUtxoInfo
          var newTimeLockUtxoInfo = new TimelockUtxoInfo();
          newTimeLockUtxoInfo.iscltv = false;
          newTimeLockUtxoInfo.locktime = newTimeLock.locktime;

          const tx = await Tx.findOne({ txid: utxo.txid });
          if (newTimeLock.type === lib.ScriptPubKeyType.CSV_P2SH_timelock_timebased) {
            newTimeLockUtxoInfo.istimebased = true;

            newTimeLockUtxoInfo.timetouse_number = newTimeLockUtxoInfo.locktime + tx.blocktime;

            const date = new Date(newTimeLockUtxoInfo.timetouse_number * 1000);
            newTimeLockUtxoInfo.timetouse_string += 'unlock at ' + date.toLocaleString();
          } else {
            newTimeLockUtxoInfo.istimebased = false;
            newTimeLockUtxoInfo.timetouse_number = newTimeLockUtxoInfo.locktime + tx.blockindex;
            newTimeLockUtxoInfo.timetouse_string += 'unlock at block height ' + newTimeLockUtxoInfo.timetouse_number;
          }

          // Update TimelockUtxoInfo to AddressUtxo
          await AddressUtxo.findOneAndUpdate(
            { a_id: newTimeLock.a_id, txid: utxo.txid, vout: utxo.vout },
            {
              $set: {
                timelockinfo: newTimeLockUtxoInfo,
              },
            }
          );
        }
      }

      return cb();
    });
  },

  //property: 'received' or 'balance'
  update_richlist: function (list, cb) {
    if (list == 'received') {
      Address.find({}, 'a_id balance received')
        .sort({ received: 'desc' })
        .limit(100)
        .exec(function (err, addresses) {
          Richlist.updateOne(
            { coin: settings.coin },
            {
              received: addresses,
            },
            function () {
              return cb();
            }
          );
        });
    } else {
      //balance
      Address.find({}, 'a_id balance received')
        .sort({ balance: 'desc' })
        .limit(100)
        .exec(function (err, addresses) {
          Richlist.updateOne(
            { coin: settings.coin },
            {
              balance: addresses,
            },
            function () {
              return cb();
            }
          );
        });
    }
  },

  get_tx: function (txid, cb) {
    find_tx(txid, function (tx) {
      return cb(tx);
    });
  },

  get_txs: function (block, cb) {
    var txs = [];
    lib.syncLoop(
      block.tx.length,
      function (loop) {
        var i = loop.iteration();
        find_tx(block.tx[i], function (tx) {
          if (tx) {
            txs.push(tx);
            loop.next();
          } else {
            loop.next();
          }
        });
      },
      function () {
        return cb(txs);
      }
    );
  },

  create_txs: function (block, cb) {
    is_locked('db_index', function (exists) {
      if (exists) {
        console.log('db_index lock file exists...');
        return cb();
      } else {
        lib.syncLoop(
          block.tx.length,
          function (loop) {
            var i = loop.iteration();
            save_tx(block.tx[i], block, function (err) {
              if (err) {
                loop.next();
              } else {
                //console.log('tx stored: %s', block.tx[i]);
                loop.next();
              }
            });
          },
          function () {
            return cb();
          }
        );
      }
    });
  },

  get_last_txs_ajax: function (start, length, min, cb) {
    Tx.find({ total: { $gte: min } }).count(function (err, count) {
      Tx.find({ total: { $gte: min } })
        .sort({ blockindex: -1 })
        .skip(Number(start))
        .limit(Number(length))
        .exec(function (err, txs) {
          if (err) {
            return cb(err);
          } else {
            return cb(txs, count);
          }
        });
    });
  },

  get_address_txs_ajax: function (hash, start, length, cb) {
    var totalCount = 0;
    AddressTx.find({ a_id: hash }).count(function (err, count) {
      if (err) {
        return cb(err);
      } else {
        totalCount = count;
        AddressTx.aggregate(
          [
            { $match: { a_id: hash } },
            { $sort: { blockindex: -1 } },
            { $skip: Number(start) },
            {
              $group: {
                _id: '',
                balance: { $sum: '$amount' },
              },
            },
            {
              $project: {
                _id: 0,
                balance: '$balance',
              },
            },
            { $sort: { blockindex: -1 } },
          ],
          function (err, balance_sum) {
            if (err) {
              return cb(err);
            } else {
              AddressTx.find({ a_id: hash })
                .sort({ blockindex: -1 })
                .skip(Number(start))
                .limit(Number(length))
                .exec(function (err, address_tx) {
                  if (err) {
                    return cb(err);
                  } else {
                    var txs = [];
                    var count = address_tx.length;
                    var running_balance = balance_sum.length > 0 ? balance_sum[0].balance : 0;

                    var txs = [];

                    lib.syncLoop(
                      count,
                      function (loop) {
                        var i = loop.iteration();
                        find_tx(address_tx[i].txid, function (tx) {
                          if (tx && !txs.includes(tx)) {
                            tx.balance = running_balance;
                            txs.push(tx);
                            loop.next();
                          } else if (!txs.includes(tx)) {
                            txs.push('1. Not found');
                            loop.next();
                          } else {
                            loop.next();
                          }
                          running_balance = running_balance - address_tx[i].amount;
                        });
                      },
                      function () {
                        return cb(txs, totalCount);
                      }
                    );
                  }
                });
            }
          }
        );
      }
    });
  },

  create_market: function (coin, exchange, market, cb) {
    var newMarkets = new Markets({
      market: market,
      coin: coin,
      exchange: exchange,
    });

    newMarkets.save(function (err) {
      if (err) {
        console.log(err);
        return cb();
      } else {
        console.log('initial markets entry created for %s', market);
        //console.log(newMarkets);
        return cb();
      }
    });
  },

  // checks market data exists for given market
  check_market: function (market, cb) {
    Markets.findOne({ market: market }, function (err, exists) {
      if (exists) {
        return cb(market, true);
      } else {
        return cb(market, false);
      }
    });
  },

  // gets market data for given market
  get_market: function (market, cb) {
    Markets.findOne({ market: market }, function (err, data) {
      if (data) {
        return cb(data);
      } else {
        return cb(null);
      }
    });
  },

  // creates initial richlist entry in database; called on first launch of explorer
  create_richlist: function (coin, cb) {
    var newRichlist = new Richlist({
      coin: coin,
    });
    newRichlist.save(function (err) {
      if (err) {
        console.log(err);
        return cb();
      } else {
        console.log('initial richlist entry created for %s', coin);
        //console.log(newRichlist);
        return cb();
      }
    });
  },

  // drops richlist data for given coin
  delete_richlist: function (coin, cb) {
    Richlist.findOneAndRemove({ coin: coin }, function (err, exists) {
      if (exists) {
        return cb(true);
      } else {
        return cb(false);
      }
    });
  },
  // checks richlist data exists for given coin
  check_richlist: function (coin, cb) {
    Richlist.findOne({ coin: coin }, function (err, exists) {
      if (exists) {
        return cb(true);
      } else {
        return cb(false);
      }
    });
  },

  create_heavy: function (coin, cb) {
    var newHeavy = new Heavy({
      coin: coin,
    });
    newHeavy.save(function (err) {
      if (err) {
        console.log(err);
        return cb();
      } else {
        console.log('initial heavy entry created for %s', coin);
        console.log(newHeavy);
        return cb();
      }
    });
  },

  check_heavy: function (coin, cb) {
    Heavy.findOne({ coin: coin }, function (err, exists) {
      if (exists) {
        return cb(true);
      } else {
        return cb(false);
      }
    });
  },

  get_heavy: function (coin, cb) {
    Heavy.findOne({ coin: coin }, function (err, heavy) {
      if (heavy) {
        return cb(heavy);
      } else {
        return cb(null);
      }
    });
  },
  get_distribution: function (richlist, stats, cb) {
    var distribution = {
      supply: stats.supply,
      t_1_25: { percent: 0, total: 0 },
      t_26_50: { percent: 0, total: 0 },
      t_51_75: { percent: 0, total: 0 },
      t_76_100: { percent: 0, total: 0 },
      t_101plus: { percent: 0, total: 0 },
    };
    lib.syncLoop(
      richlist.balance.length,
      function (loop) {
        var i = loop.iteration();
        var count = i + 1;
        var percentage = (richlist.balance[i].balance / 1000000 / stats.supply) * 100;
        if (count <= 25) {
          distribution.t_1_25.percent = distribution.t_1_25.percent + percentage;
          distribution.t_1_25.total = distribution.t_1_25.total + richlist.balance[i].balance / 1000000;
        }
        if (count <= 50 && count > 25) {
          distribution.t_26_50.percent = distribution.t_26_50.percent + percentage;
          distribution.t_26_50.total = distribution.t_26_50.total + richlist.balance[i].balance / 1000000;
        }
        if (count <= 75 && count > 50) {
          distribution.t_51_75.percent = distribution.t_51_75.percent + percentage;
          distribution.t_51_75.total = distribution.t_51_75.total + richlist.balance[i].balance / 1000000;
        }
        if (count <= 100 && count > 75) {
          distribution.t_76_100.percent = distribution.t_76_100.percent + percentage;
          distribution.t_76_100.total = distribution.t_76_100.total + richlist.balance[i].balance / 1000000;
        }
        loop.next();
      },
      function () {
        distribution.t_101plus.percent = parseFloat(
          100 -
            distribution.t_76_100.percent -
            distribution.t_51_75.percent -
            distribution.t_26_50.percent -
            distribution.t_1_25.percent
        ).toFixed(2);
        distribution.t_101plus.total = parseFloat(
          distribution.supply -
            distribution.t_76_100.total -
            distribution.t_51_75.total -
            distribution.t_26_50.total -
            distribution.t_1_25.total
        ).toFixed(8);
        distribution.t_1_25.percent = parseFloat(distribution.t_1_25.percent).toFixed(2);
        distribution.t_1_25.total = parseFloat(distribution.t_1_25.total).toFixed(8);
        distribution.t_26_50.percent = parseFloat(distribution.t_26_50.percent).toFixed(2);
        distribution.t_26_50.total = parseFloat(distribution.t_26_50.total).toFixed(8);
        distribution.t_51_75.percent = parseFloat(distribution.t_51_75.percent).toFixed(2);
        distribution.t_51_75.total = parseFloat(distribution.t_51_75.total).toFixed(8);
        distribution.t_76_100.percent = parseFloat(distribution.t_76_100.percent).toFixed(2);
        distribution.t_76_100.total = parseFloat(distribution.t_76_100.total).toFixed(8);
        return cb(distribution);
      }
    );
  },
  // updates heavy stats for coin
  // height: current block height, count: amount of votes to store
  update_heavy: function (coin, height, count, cb) {
    var newVotes = [];
    lib.get_maxmoney(function (maxmoney) {
      lib.get_maxvote(function (maxvote) {
        lib.get_vote(function (vote) {
          lib.get_phase(function (phase) {
            lib.get_reward(function (reward) {
              lib.get_supply(function (supply) {
                lib.get_estnext(function (estnext) {
                  lib.get_nextin(function (nextin) {
                    lib.syncLoop(
                      count,
                      function (loop) {
                        var i = loop.iteration();
                        lib.get_blockhash(height - i, function (hash) {
                          lib.get_block(hash, function (block) {
                            newVotes.push({ count: height - i, reward: block.reward, vote: block.vote });
                            loop.next();
                          });
                        });
                      },
                      function () {
                        console.log(newVotes);
                        Heavy.updateOne(
                          { coin: coin },
                          {
                            lvote: vote,
                            reward: reward,
                            supply: supply,
                            cap: maxmoney,
                            estnext: estnext,
                            phase: phase,
                            maxvote: maxvote,
                            nextin: nextin,
                            votes: newVotes,
                          },
                          function () {
                            //console.log('address updated: %s', hash);
                            return cb();
                          }
                        );
                      }
                    );
                  });
                });
              });
            });
          });
        });
      });
    });
  },

  // updates market data for given market; called by sync.js
  update_markets_db: function (market, cb) {
    get_market_data(market, function (err, obj) {
      if (err == null) {
        Markets.updateOne(
          { market: market },
          {
            chartdata: JSON.stringify(obj.chartdata),
            buys: obj.buys,
            sells: obj.sells,
            history: obj.trades,
            summary: obj.stats,
          },
          function () {
            if (market == settings.markets.default) {
              Stats.updateOne(
                { coin: settings.coin },
                {
                  last_price: obj.stats.last,
                },
                function () {
                  return cb(null);
                }
              );
            } else {
              return cb(null);
            }
          }
        );
      } else {
        return cb(err);
      }
    });
  },

  // updates stats data for given coin; called by sync.js
  update_db: function (coin, cb) {
    lib.get_blockcount(function (count) {
      if (!count) {
        console.log('Unable to connect to explorer API');
        return cb(false);
      }
      lib.get_supply(function (supply) {
        lib.get_connectioncount(function (connections) {
          Stats.findOneAndUpdate(
            { coin: coin },
            {
              $set: {
                coin: coin,
                count: count,
                supply: supply,
                connections: connections,
              },
            },
            {
              new: true,
            },
            function (err, new_stats) {
              if (err) {
                console.log('Error during Stats Update:', err);
              }
              var last_temp = new_stats.last ? new_stats.last : 0;
              return cb({ coin: coin, count: count, supply: supply, connections: connections, last: last_temp });
            }
          );
        });
      });
    });
  },

  // updates tx, address & richlist db's; called by sync.js
  update_tx_mempool: function (block_height, timeout, cb) {
    lib.get_rawmempool(function (txid_mempool) {
      // First txid is the latest one so reverse it
      txid_mempool.reverse();
      // Refer block format http://explorer.yacoin.org/api/getblock?hash=000003aa811cab7a4c778ed496d7111dd20ea2d446a76cd22fcd047091d47390
      async.eachLimit(
        txid_mempool,
        1,
        function (txid, next_tx) {
          AddressUtxoMempool.findOne({ blockheight: block_height, txid: txid }, function (err, tx) {
            if (tx) {
              setTimeout(function () {
                tx = null;
                next_tx();
              }, timeout);
            } else {
              save_tx_mempool(txid, block_height, function (err) {
                if (err) {
                  console.log(err);
                } else {
                  console.log('%s: %s', block_height, txid);
                }
                setTimeout(function () {
                  tx = null;
                  next_tx();
                }, timeout);
              });
            }
          });
        },
        function () {
          remove_lock('db_index', function () {
            return cb();
          });
        }
      );
    });
  },

  reindex_tx_db: function (txid, cb) {
    is_locked('db_index', function (exists) {
      if (exists) {
        console.log('db_index lock file exists...');
        return cb();
      } else {
        create_lock('db_index', function () {
          reindex_tx(txid, function (err) {
            if (err) {
              console.log(err);
            }
            return cb();
          });
        });
      }
    });
  },

  update_tx_db: function (coin, start, end, timeout, cb) {
    is_locked('db_index', function (exists) {
      if (exists) {
        console.log('db_index lock file exists...');
        return cb();
      } else {
        create_lock('db_index', function () {
          if (start < 1) {
            start = 1;
          }
          // recheck 100 old blocks to reindex when reorg happens
          if (end - start < 10) {
            start = end - 99;
          }
          var complete = false;
          var blocks_to_scan = [];
          var task_limit_blocks = settings.block_parallel_tasks;
          if (task_limit_blocks < 1) {
            task_limit_blocks = 1;
          }
          var task_limit_txs = 1;
          for (i = start; i < end + 1; i++) {
            blocks_to_scan.push(i);
          }
          async.eachLimit(
            blocks_to_scan,
            task_limit_blocks,
            function (block_height, next_block) {
              if (block_height % 5000 === 0) {
                Stats.updateOne(
                  { coin: coin },
                  {
                    last: block_height - 1,
                    last_txs: '', //not used anymore left to clear out existing objects
                  },
                  function () {}
                );
              }
              lib.get_blockhash(block_height, function (blockhash) {
                if (blockhash) {
                  lib.get_block(blockhash, async function (block) {
                    if (block) {
                      // Check if the block with this block height is already in the db
                      const blockinDB = await Block.findOne({ blockheight: block.height });
                      if (blockinDB) {
                        // If block is already in the db and blockinDB.blockhash is different with current block hash, it means that reorg happens
                        const oldBlockHash = blockinDB.blockhash;
                        if (oldBlockHash !== block.hash) {
                          console.log(
                            'WARNING !!! reorg at block height ' +
                              block.height +
                              ' (from block ' +
                              oldBlockHash +
                              ' to block ' +
                              block.hash +
                              ')'
                          );
                          await Block.findOneAndUpdate(
                            { blockheight: block.height },
                            {
                              $set: {
                                blockhash: block.hash,
                                blocktime: block.time,
                              },
                            }
                          );

                          // Find the old coinbase tx in the old block having old blockhash
                          const oldTxs = await Tx.find({ blockhash: oldBlockHash });
                          var coinbaseAmount = {};
                          var coinbaseAddress = '';
                          for (var oldTx of oldTxs) {
                            for (var oldvin of oldTx.vin) {
                              if (oldvin.addresses === 'coinbase') {
                                oldCoinbaseTx = oldTx.txid;
                                coinbaseAmount.received = -oldTx.vout[0].amount;
                                coinbaseAmount.balance = -oldTx.vout[0].amount;
                                coinbaseAddress = oldTx.vout[0].addresses;
                                break;
                              }
                            }

                            if (oldCoinbaseTx !== null) {
                              break;
                            }
                          }
                          // remove the old coinbase tx from addressutxo, addresstx db (still keep tx in tx db for reference)
                          await AddressUtxo.deleteMany({ txid: oldCoinbaseTx });
                          await AddressTx.deleteMany({ txid: oldCoinbaseTx });

                          // reupdate balance of address containing old coinbase utxo
                          await Address.findOneAndUpdate(
                            { a_id: coinbaseAddress },
                            {
                              $inc: coinbaseAmount,
                            }
                          );
                        }
                      } else {
                        var newBlock = new Block({
                          blockheight: block.height,
                          blockhash: block.hash,
                          blocktime: block.time,
                        });
                        await newBlock.save();
                      }

                      // Refer block format http://explorer.yacoin.org/api/getblock?hash=000003aa811cab7a4c778ed496d7111dd20ea2d446a76cd22fcd047091d47390
                      var oldCoinbaseTx = null;
                      // Process all transaction in block
                      for (var txid of block.tx) {
                        var tx = await Tx.findOne({ txid: txid });
                        if (tx) {
                          // If tx is already in the db and tx.blockhash is different with current block hash, it means that reorg happens
                          if (tx.blockhash !== blockhash) {
                            // store block info to use later
                            const oldBlockHash = tx.blockhash;
                            const oldBlockHeight = tx.blockindex;

                            // reupdate tx db (blockhash, blockindex, blocktime)
                            await Tx.findOneAndUpdate(
                              { txid: tx.txid },
                              {
                                $set: {
                                  blockhash: block.hash,
                                  blockindex: block.height,
                                  blocktime: block.time,
                                },
                              }
                            );
                            console.log(
                              'WARNING !!! tx ' +
                                tx.txid +
                                ' reorg from block ' +
                                oldBlockHash +
                                ' (height ' +
                                oldBlockHeight +
                                ') to block ' +
                                block.hash +
                                ' (height ' +
                                block.height +
                                ')'
                            );

                            // reupdate addressutxo db (timelockinfo) from tx.vout
                            const txData = await lib.get_rawtransaction_promise(tx.txid);
                            for (var i = 0; i < txData.vout.length; i++) {
                              const vout = txData.vout[i];
                              // Prepare timelock info
                              var result = await lib.get_timelockutxoinfo(vout, block, blockhash);
                              if (result.timelockUtxoInfo !== null) {
                                await AddressUtxo.findOneAndUpdate(
                                  {
                                    a_id: vout.scriptPubKey.addresses[0],
                                    txid: tx.txid,
                                    vout: i,
                                  },
                                  {
                                    $set: {
                                      timelockinfo: result.timelockUtxoInfo,
                                    },
                                  }
                                );
                              }
                            }

                            // reupdate addresstx (blockindex)
                            await AddressTx.updateMany(
                              { txid: tx.txid },
                              {
                                $set: {
                                  blockindex: block.height,
                                },
                              }
                            );
                          }
                        } else {
                          try {
                            await save_tx_promise(txid, block);
                            console.log('%s: %s', block_height, txid);
                          } catch (err) {
                            console.log(err);
                          }
                        }
                      }
                      // Process next block
                      next_block();
                    } else {
                      console.log('block not found: %s', blockhash);
                      setTimeout(function () {
                        next_block();
                      }, timeout);
                    }
                  });
                } else {
                  setTimeout(function () {
                    next_block();
                  }, timeout);
                }
              });
            },
            function () {
              Tx.find({})
                .sort({ timestamp: 'desc' })
                .limit(settings.index.last_txs)
                .exec(function (err, txs) {
                  Stats.updateOne(
                    { coin: coin },
                    {
                      last: end,
                      last_txs: '', //not used anymore left to clear out existing objects
                    },
                    function () {
                      remove_lock('db_index', function () {
                        return cb();
                      });
                    }
                  );
                });
            }
          );
        });
      }
    });
  },

  create_peer: function (params, cb) {
    var newPeer = new Peers(params);
    newPeer.save(function (err) {
      if (err) {
        console.log(err);
        return cb();
      } else {
        return cb();
      }
    });
  },

  find_peer: function (address, cb) {
    Peers.findOne({ address: address }, function (err, peer) {
      if (err) {
        return cb(null);
      } else {
        if (peer) {
          return cb(peer);
        } else {
          return cb(null);
        }
      }
    });
  },

  drop_peer: function (address, cb) {
    Peers.deleteOne({ address: address }, function (err) {
      if (err) {
        console.log(err);
        return cb();
      } else {
        return cb();
      }
    });
  },

  drop_peers: function (cb) {
    Peers.deleteMany({}, function (err) {
      if (err) {
        console.log(err);
        return cb();
      } else {
        return cb();
      }
    });
  },

  get_peers: function (cb) {
    Peers.find({}, function (err, peers) {
      if (err) {
        return cb([]);
      } else {
        return cb(peers);
      }
    });
  },
};
