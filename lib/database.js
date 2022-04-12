var mongoose = require('mongoose')
  , Stats = require('../models/stats')
  , Markets = require('../models/markets')
  , Address = require('../models/address')
  , AddressTx = require('../models/addresstx')
  , AddressUtxo = require('../models/addressutxo')
  , AddressUtxoMempool = require('../models/addressutxomempool')
  , Tx = require('../models/tx')
  , Richlist = require('../models/richlist')
  , TimeLock = require('../models/timelock')
  , CsvInfo = require('../models/csvinfo')
  , Peers = require('../models/peers')
  , Heavy = require('../models/heavy')
  , lib = require('./explorer')
  , settings = require('./settings')
  , fs = require('fs')
  , async = require('async');

mongoose.set('useCreateIndex', true);
mongoose.set('useUnifiedTopology', true);
mongoose.set('useNewUrlParser', true);
mongoose.set('useFindAndModify', false);

const util = require('util');
const SEQUENCE_LOCKTIME_TYPE_FLAG = (1 << 30);
const SEQUENCE_LOCKTIME_MASK = 0x3fffffff;
const SEQUENCE_LOCKTIME_GRANULARITY = 0;

function find_address(hash, cb) {
  Address.findOne({a_id: hash}, function(err, address) {
    if(address) {
      return cb(address);
    } else {
      return cb();
    }
  });
}

function find_utxo_mempool(blockheight, address, cb) {
  AddressUtxoMempool.find({blockheight: blockheight, a_id: address}, function(err, utxos) {
    console.log("TACA ===> find_utxo_mempool, utxo = %s", util.inspect(utxos, true, null, true))
    if(utxos.length > 0) {
      result = utxos.filter(function(utxo) {
        return utxo.isused === false
      })
      console.log("TACA ===> find_utxo_mempool, result = %s", util.inspect(result, true, null, true))
      return cb(true, result);
    } else {
      return cb(false);
    }
  });
}

function find_utxo(address, cb) {
  AddressUtxo.find({a_id: address, isused: false}, function(err, utxo) {
    console.log("TACA ===> find_utxo, utxo = %s", util.inspect(utxo, true, null, true))
    return cb(utxo);
  });
}

function find_address_tx(address, hash, cb) {
  AddressTx.findOne({a_id: address, txid: hash}, function(err, address_tx) {
    if(address_tx) {
      return cb(address_tx);
    } else {
      return cb();
    }
  });
}

function find_richlist(coin, cb) {
  Richlist.findOne({coin: coin}, function(err, richlist) {
    if(richlist) {
      return cb(richlist);
    } else {
      return cb();
    }
  });
}

function find_timelock(redeemscript, cb) {
  TimeLock.findOne({redeemscript: redeemscript}, function(err, timelock) {
    if(timelock) {
      return cb(timelock);
    } else {
      return cb();
    }
  });
}

// hash = address
async function update_address_mempool(hash, block_height, txid, amount, type, tx_info, cb) {
  var to_sent = false;
  var to_received = false;
  var addr_inc = {}

  // Initialize AddressUtxoMempool db
  await AddressUtxoMempool.findOne({
    blockheight: block_height,
    a_id: hash,
  })
  .exec()
  .then(async function (utxos) {
    if (!utxos) {
      console.log(
        "TACA database.js, update_address_mempool ===> BEGIN Initialize AddressUtxoMempool db in block_height = %s for address = %s",
        block_height,
        hash
      );
      await AddressUtxo.find({a_id: hash}).exec().then(async function(utxo) {
        for (var i = 0; i < utxo.length; i++) {
          await Tx.findOne({ txid: utxo[i].txid })
          .exec()
          .then(async function (tx) {
            blockutxoheight = block_height
            if(tx) {
              blockutxoheight = tx.blockindex
            }
            var newAddressUtxoMempool = new AddressUtxoMempool({
              blockheight: block_height,
              a_id: hash,
              blockutxoheight: blockutxoheight,
              txid: utxo[i].txid,
              vout: utxo[i].vout,
              isused: utxo[i].isused,
              amount: utxo[i].amount,
            });
            await newAddressUtxoMempool.save()
            console.log("TACA ===> update_address_mempool, find utxos in blockchain for address = %s, newAddressUtxoMempool = %s", hash, util.inspect(newAddressUtxoMempool, true, null, true))
          });
        }
        console.log(
          "TACA database.js, update_address_mempool ===> END Initialize AddressUtxoMempool db in block_height = %s for address = %s",
          block_height,
          hash
        );
      });
    }
  });

  console.log("TACA database.js, update_address_mempool ===> Update AddressUtxoMempool");
  if (type == 'vin') {
    addr_inc.sent = amount;
    addr_inc.balance = -amount;
    // There must be some UTXOs are used
    await AddressUtxoMempool.findOneAndUpdate(
      { blockheight: block_height, a_id: hash, txid: tx_info.prevTxid, vout: tx_info.prevVout},
      {
        $set: {
          isused: true,
        },
      },
      {
        new: true, // return the modified document rather than the original
      }
    ).exec().then(function (addressUtxo) {
      console.log("TACA database.js, update_address_mempool ===> Used addressUtxo = %s", util.inspect(addressUtxo, true, null, true));
    });
  } else {
    addr_inc.received = amount;
    addr_inc.balance = amount;
    // There are new UTXOs
    var newAddressUtxoMempool = new AddressUtxoMempool({
      blockheight: block_height,
      a_id: hash,
      blockutxoheight: block_height,
      txid: txid,
      vout: tx_info.curVout,
      isused: false,
      amount: amount,
    });
    await newAddressUtxoMempool.save()
    console.log("TACA database.js, update_address_mempool ===> New newAddressUtxoMempool = %s", util.inspect(newAddressUtxoMempool, true, null, true));
  }
  return cb()
}

// hash = address
async function update_address(hash, blockheight, txid, amount, type, tx_info, cb) {
  var to_sent = false;
  var to_received = false;
  var addr_inc = {}
  if ( hash == 'coinbase' ) { // it must by type = 'vin'
    addr_inc.sent = amount;
  } else {
    if (type == 'vin') {
      addr_inc.sent = amount;
      addr_inc.balance = -amount;
      // There must be some UTXOs are used
      await await AddressUtxo.findOneAndUpdate(
        { a_id: hash, txid: tx_info.prevTxid, vout: tx_info.prevVout},
        {
          $set: {
            isused: true,
          },
        },
        {
          new: true, // return the modified document rather than the original
        }
      ).exec().then(function (addressUtxo) {
        console.log("TACA database.js, update_address ===> Used addressUtxo = %s", util.inspect(addressUtxo, true, null, true));
      });
    } else {
      addr_inc.received = amount;
      addr_inc.balance = amount;
      // There are new UTXOs
      var newAddressUtxo = new AddressUtxo({
        a_id: hash,
        txid: txid,
        vout: tx_info.curVout,
        isUsed: false,
        amount: amount,
      });
      await newAddressUtxo.save()
      console.log("TACA database.js, update_address ===> New newAddressUtxo = %s", util.inspect(newAddressUtxo, true, null, true));
    }
  }
  console.log("TACA database.js, update_address ===> BEGIN update Address db for address = %s, increase amount = %s, tx_info.prevTxid = %s", hash, addr_inc.balance, tx_info.prevTxid);
  // Update (or create new document) sent, received, balance of an address
  Address.findOneAndUpdate({a_id: hash}, {
    $inc: addr_inc
  }, {
    new: true, // return the modified document rather than the original
    upsert: true // creates the object if it doesn't exist. defaults to false.
  }, function (err, address) {
    if (err) {
      return cb(err);
    } else {
      if ( hash != 'coinbase' ) {
        console.log("TACA database.js, update_address ===> END update Address db for address = %s, new info = %s", hash, util.inspect(address, true, null, true));
        console.log("TACA database.js, update_address ===> update AddressTx db for address = %s, txid = %s, increase amount = %s", hash, txid, addr_inc.balance);
        // Update (or create new document) transaction of an address
        AddressTx.findOneAndUpdate({a_id: hash, txid: txid}, {
          $inc: {
            amount: addr_inc.balance
          },
          $set: {
            a_id: hash,
            blockindex: blockheight,
            txid: txid
          }
        }, {
          new: true,
          upsert: true
        }, function (err,addresstx) {
          if (err) {
            return cb(err);
          } else {
            // Update balance of timelock address
            TimeLock.findOne({a_id: hash}, function (err, timelockaddress) {
                if (!err && timelockaddress) {
                  if (timelockaddress.iscltv) { // Cltv address
                    TimeLock.findOneAndUpdate({a_id: hash}, {
                      $set: {
                        balance: address.balance
                      }
                    }, {
                      new: true
                    }, function (err, timelock) {
                      if (err) {
                        return cb(err);
                      } else {
                        return cb();
                      }
                    });
                  } else { // Csv address
                    if (type == 'vin') { // use existing UTXO, update document of CsvInfo db
                      CsvInfo.findOneAndUpdate({a_id: hash, txid: tx_info.prevTxid}, {
                        $set: {
                          isused: true
                        }
                      }, function (err, csvinfo) {
                        if (err) {
                          return cb(err);
                        } else {
                          CsvInfo.find({a_id: hash, isused: false}).sort({timetouse_number: 'asc'}).limit(10).exec(function(err, csvinfo){
                            TimeLock.findOneAndUpdate({a_id: hash}, {
                              $set: {
                                balance: address.balance,
                                csvinfo: csvinfo
                              }
                            }, {
                              new: true
                            }, function (err, timelock) {
                              if (err) {
                                return cb(err);
                              } else {
                                return cb();
                              }
                            });
                          });
                        }
                      });
                    } else { // new UTXO, add new document to CsvInfo db
                      save_csvinfo(hash, txid, amount, timelockaddress.locktime, timelockaddress.istimebased, blockheight, function(err) {
                        if (err) {
                          return cb(err);
                        } else {
                          CsvInfo.find({a_id: hash, isused: false}).sort({timetouse_number: 'asc'}).limit(10).exec(function(err, csvinfo){
                            TimeLock.findOneAndUpdate({a_id: hash}, {
                              $set: {
                                balance: address.balance,
                                csvinfo: csvinfo
                              }
                            }, {
                              new: true
                            }, function (err, timelock) {
                              if (err) {
                                return cb(err);
                              } else {
                                return cb();
                              }
                            });
                          });
                        }
                      });
                    }
                  }
                } else {
                  return cb();
                }
            });
          }
        });
      } else {
        return cb();
      }
    }
  });
}

function update_csvinfo(address, txid, locktime, istimebased, cb){
  Tx.findOne({txid: txid}, function (err, tx) {
    if (err) {
      return cb(err);
    }
    lib.syncLoop(tx.vin.length, function (loop) {
      var i = loop.iteration();
      if (tx.vin[i].addresses == address) {
        CsvInfo.findOneAndUpdate({a_id: address, txid: tx.vin[i].txid}, {
          $set: {
            isused: true
          }
        }, function (err, csvinfo) {
          if (err) {
            return cb(err);
          }
        });
      }
      loop.next();
    }, function() {
      lib.syncLoop(tx.vout.length, function (subloop) {
        var t = subloop.iteration();
        if (tx.vout[t].addresses == address) {
          save_csvinfo(address, txid, tx.vout[t].amount, locktime, istimebased, tx.blockindex, function(err) {
            if (err) {
              return cb(err);
            }
            subloop.next();
          });
        } else {
          subloop.next();
        }
      }, function() {
        return cb();
      });
    });
  });
}

function save_csvinfo(address, txid, amount, locktime, istimebased, blockheight, cb){
  lib.get_block_by_number(blockheight-1, function (block) {
    var timetouse_number = 0;
    var timetouse_string = "";

    if (istimebased) {
      timetouse_number = locktime + block.time;
      const date = new Date(timetouse_number * 1000);
      timetouse_string += "unlock at " + date.toLocaleString();
    } else {
      timetouse_number = locktime + blockheight;
      timetouse_string += "unlock at block height " + timetouse_number;
    }

    var newCsvInfo = new CsvInfo({
      a_id: address,
      txid: txid,
      isused: false,
      amount: amount,
      timetouse_number: timetouse_number,
      timetouse_string: timetouse_string,
    });
    newCsvInfo.save(function(err) {
      if (err) {
        return cb(err);
      } else {
        return cb();
      }
    });
  });
}

function find_tx(txid, cb) {
  Tx.findOne({txid: txid}, function(err, tx) {
    if(tx) {
      return cb(tx);
    } else {
      return cb(null);
    }
  });
}

function save_tx_mempool(txid, block_height, cb) {
  //var s_timer = new Date().getTime();
  console.log("TACA database.js, save_tx_mempool ===> call lib.get_rawtransaction for txid = %s", txid);
  lib.get_rawtransaction(txid, function(tx){
    // Refer tx format http://explorer.yacoin.org/api/getrawtransaction?txid=51e24109397d06376fd61e50d9d59b4164d6a41bf64fcf959bdd79077f61e2ca&decrypt=1
    console.log("TACA database.js, save_tx_mempool ===> txid = %s, tx = %s", txid, util.inspect(tx, true, null, true));
    if (tx != 'There was an error. Check your console.') {
      lib.prepare_vin(tx, function(vin) { // prepare list of {vin_address, sent_amount}
        lib.prepare_vout(tx.vout, txid, vin, function(vout, nvin) { // prepare list of {vout_address, received_amount}
          console.log("TACA database.js, save_tx_mempool ===> vin = %s, vout = %s", util.inspect(nvin, true, null, true), util.inspect(vout, true, null, true));
          lib.syncLoop(vin.length, function (loop) {
            // Update balance and transaction of addresses used as vin
            var i = loop.iteration();
            console.log("TACA database.js, save_tx_mempool ===> update vin[%s/%s], address = %s, amount = %s, prevTxid = %s", i+1, vin.length, nvin[i].addresses, nvin[i].amount, nvin[i].txid);
            tx_info = {
              prevTxid: nvin[i].prevTxid,
              prevVout: nvin[i].prevVout,
              curVout: null
            }
            update_address_mempool(nvin[i].addresses, block_height, txid, nvin[i].amount, 'vin', tx_info, function(){
              loop.next();
            });
          }, function(){
            lib.syncLoop(vout.length, function (subloop) {
              var t = subloop.iteration();
              if (vout[t].addresses) {
                // Update balance and transaction of addresses in vout
                tx_info = {
                  prevTxid: null,
                  prevVout: null,
                  curVout: t
                }
                console.log("TACA database.js, save_tx_mempool ===> update vout[%s/%s], address = %s, amount = %s", t+1, vout.length, vout[t].addresses, vout[t].amount);
                update_address_mempool(vout[t].addresses, block_height, txid, vout[t].amount, 'vout', tx_info, function(){
                  subloop.next();
                });
              } else {
                subloop.next();
              }
            }, function(){
              console.log("TACA database.js, save_tx_mempool ===> complete for txid = %s", txid);
              return cb()
            });
          });
        });
      });
    } else {
      return cb('tx not found: ' + txid);
    }
  });
}

function save_tx(txid, blockheight, cb) {
  //var s_timer = new Date().getTime();
  console.log("TACA database.js, save_tx ===> call lib.get_rawtransaction for txid = %s", txid);
  lib.get_rawtransaction(txid, function(tx){
    // Refer tx format http://explorer.yacoin.org/api/getrawtransaction?txid=51e24109397d06376fd61e50d9d59b4164d6a41bf64fcf959bdd79077f61e2ca&decrypt=1
    console.log("TACA database.js, save_tx ===> txid = %s, tx = %s", txid, util.inspect(tx, true, null, true));
    if (tx != 'There was an error. Check your console.') {
      lib.prepare_vin(tx, function(vin) { // prepare list of {vin_address, sent_amount}
        lib.prepare_vout(tx.vout, txid, vin, function(vout, nvin) { // prepare list of {vout_address, received_amount}
          console.log("TACA database.js, save_tx ===> vin = %s, vout = %s", util.inspect(nvin, true, null, true), util.inspect(vout, true, null, true));
          lib.syncLoop(vin.length, function (loop) {
            // Update balance and transaction of addresses used as vin
            var i = loop.iteration();
            console.log("TACA database.js, save_tx ===> update vin[%s/%s], address = %s, amount = %s, prevTxid = %s", i+1, vin.length, nvin[i].addresses, nvin[i].amount, nvin[i].txid);
            tx_info = {
              prevTxid: nvin[i].prevTxid,
              prevVout: nvin[i].prevVout,
              curVout: null
            }
            update_address(nvin[i].addresses, blockheight, txid, nvin[i].amount, 'vin', tx_info, function(){
              loop.next();
            });
          }, function(){
            lib.syncLoop(vout.length, function (subloop) {
              var t = subloop.iteration();
              if (vout[t].addresses) {
                // Update balance and transaction of addresses in vout
                tx_info = {
                  prevTxid: null,
                  prevVout: null,
                  curVout: t
                }
                console.log("TACA database.js, save_tx ===> update vout[%s/%s], address = %s, amount = %s", t+1, vout.length, vout[t].addresses, vout[t].amount);
                update_address(vout[t].addresses, blockheight, txid, vout[t].amount, 'vout', tx_info, function(){
                  subloop.next();
                });
              } else {
                subloop.next();
              }
            }, function(){
              // Create new document about tx
              lib.calculate_total(vout, function(total){
                var newTx = new Tx({
                  txid: tx.txid,
                  vin: nvin, // array of {vin_address, sent_amount}
                  vout: vout, // array of {vout_address, received_amount}
                  total: total.toFixed(8), // total value of vout
                  timestamp: tx.time,
                  blockhash: tx.blockhash,
                  blockindex: blockheight,
                });
                console.log("TACA database.js, save_tx ===> update tx db for txid = %s, tx info = %s", tx.txid, util.inspect(newTx, true, null, true));
                newTx.save(function(err) {
                  if (err) {
                    return cb(err);
                  } else {
                    //console.log('txid: ');
                    return cb();
                  }
                });
              });
            });
          });
        });
      });
    } else {
      return cb('tx not found: ' + txid);
    }
  });
}

function get_market_data(market, cb) {
  if(fs.existsSync('./lib/markets/' + market + '.js')){
    exMarket = require('./markets/' + market);
    exMarket.get_data(settings.markets, function(err, obj){
      return cb(err, obj);
    });
  }else{
    return cb(null);
  }
}

function create_lock(lockfile, cb) {
  if (settings.lock_during_index == true) {
    var fname = './tmp/' + lockfile + '.pid';
    fs.appendFile(fname, process.pid.toString(), function (err) {
      if (err) {
        console.log("Error: unable to create %s", fname);
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
    fs.unlink(fname, function (err){
      if(err) {
        console.log("unable to remove lock: %s", fname);
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
    fs.exists(fname, function (exists){
      if(exists) {
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
  connect: function(database, cb) {
    mongoose.connect(database, function(err) {
      if (err) {
        console.log('Unable to connect to database: %s', database);
        console.log('Aborting');
        process.exit(1);

      }
      //console.log('Successfully connected to MongoDB');
      return cb();
    });
  },

  is_locked: function(cb) {
    is_locked("db_index", function (exists) {
      if (exists) {
        return cb(true);
      } else {
        return cb(false);
      }
    });
  },

  update_label: function(hash, message, cb){
    find_address(hash, function(address){
      if(address){
        Address.updateOne({a_id:hash}, {
          name: message,
        }, function(){
          return cb();
        })
      }
    })
  },

  check_stats: function(coin, cb) {
    Stats.findOne({coin: coin}, function(err, stats) {
      if(stats) {
        return cb(true);
      } else {
        return cb(false);
      }
    });
  },

  get_stats: function(coin, cb) {
    Stats.findOne({coin: coin}, function(err, stats) {
      if(stats) {
        return cb(stats);
      } else {
        return cb(null);
      }
    });
  },

  create_stats: function(coin, cb) {
    var newStats = new Stats({
      coin: coin,
      last: 0,
    });

    newStats.save(function(err) {
      if (err) {
        console.log(err);
        return cb();
      } else {
        console.log("initial stats entry created for %s", coin);
        //console.log(newStats);
        return cb();
      }
    });
  },

  get_address: function(hash, cb) {
    find_address(hash, function(address){
      return cb(address);
    });
  },

  get_richlist: function(coin, cb) {
    find_richlist(coin, function(richlist){
      return cb(richlist);
    });
  },

  get_timelock: function(redeemscript, cb) {
    find_timelock(redeemscript, function(timelock) {
      return cb(timelock);
    });
  },

  get_timelocklist: function (cb) {
    TimeLock.find({}).sort({ balance: 'desc' }).limit(100).exec(function (err, timelocklist) {
      if (timelocklist) {
        return cb(timelocklist);
      } else {
        return cb();
      }
    });
  },

  get_utxo_mempool: function(blockheight, address, cb) {
    console.log("TACA ===> get_utxo_mempool, blockheight = %s, address = %s", blockheight, address)
    find_utxo_mempool(blockheight, address, function(found, utxo){
      return cb(found, utxo);
    });
  },

  get_utxo: function(address, cb) {
    console.log("TACA ===> get_utxo, address = %s", address)
    find_utxo(address, function(utxo){
      return cb(utxo);
    });
  },

  get_utxo_mempool_info: function(blockheight, address, cb) {
    utxo_mempool_info = {
      funded_txo_count: 0,
      funded_txo_sum: 0,
      spent_txo_count: 0,
      spent_txo_sum: 0,
    }
    new_txcount = 0
    console.log("TACA ===> get_utxo_mempool_info, blockheight = %s, address = %s", blockheight, address)
    AddressUtxoMempool.find({blockheight: blockheight, a_id: address}, function(err, funded_txo_mempool) {
      if(funded_txo_mempool.length > 0) {
        console.log("TACA ===> get_utxo_mempool_info, funded_txo_mempool = %s", util.inspect(funded_txo_mempool, true, null, true))
        funded_txo_mempool.forEach(function(txo) {
          utxo_mempool_info.funded_txo_count++
          utxo_mempool_info.funded_txo_sum += txo.amount
          if (txo.isused) {
            utxo_mempool_info.spent_txo_count++
            utxo_mempool_info.spent_txo_sum += txo.amount
          }
          if(txo.blockutxoheight == blockheight) {
            new_txcount++
          }
          console.log("TACA ===> get_utxo_mempool_info, utxo_mempool_info = %s, new_txcount = %s", util.inspect(utxo_mempool_info, true, null, true), new_txcount)
        })
        return cb(utxo_mempool_info, new_txcount)
      } else {
        return cb();
      }
    });
  },

  get_utxo_info: function(address, cb) {
    utxo_info = {
      funded_txo_count: 0,
      funded_txo_sum: 0,
      spent_txo_count: 0,
      spent_txo_sum: 0,
    }
    console.log("TACA ===> get_utxo_info, address = %s", address)
    AddressUtxo.find({a_id: address}, function(err, funded_txo) {
      if(funded_txo.length > 0) {
        console.log("TACA ===> get_utxo_info, funded_txo = %s", util.inspect(funded_txo, true, null, true))
        utxo_info = funded_txo.reduce(function(acc, txo) {
          acc.funded_txo_count++
          acc.funded_txo_sum += txo.amount
          if (txo.isused) {
              acc.spent_txo_count++
              acc.spent_txo_sum += txo.amount
          }
          console.log("TACA ===> get_utxo_info, acc = %s", util.inspect(acc, true, null, true))
          return acc
        }, utxo_info)
      }
      return cb(utxo_info);
    });
  },

  get_txcount: function(address, cb) {
    AddressTx.find({a_id: address}).count(function(err, count){
      if (err) {
        return cb(0)
      } else {
        return cb(count)
      }
    })
  },

  add_timelock: function(describeinfo, cb){
    // Prepare new document
    var newTimeLock = new TimeLock({ redeemscript: describeinfo.RedeemScriptHex });
    newTimeLock.locktime = parseInt(describeinfo.RedeemScriptFormat.substr(0, describeinfo.RedeemScriptFormat.indexOf(' ')));
    var opcodeStr = "";
    var lockCondition = "";

    if (describeinfo.RedeemScriptFormat.includes("OP_CHECKLOCKTIMEVERIFY")) {
      opcodeStr = "OP_CHECKLOCKTIMEVERIFY opcode"
      newTimeLock.a_id = describeinfo.CltvAddress
      newTimeLock.iscltv = true;
      if (newTimeLock.locktime < 500000000) { // Block-based lock
        newTimeLock.istimebased = false;
        lockCondition += "locked until block height " + newTimeLock.locktime;
      } else { // Time-based lock 
        newTimeLock.istimebased = true;
        const date = new Date(newTimeLock.locktime * 1000);
        lockCondition += "locked until " + date.toLocaleString();
      }
    } else {
      opcodeStr = "OP_CHECKSEQUENCEVERIFY opcode";
      newTimeLock.a_id = describeinfo.CsvAddress
      newTimeLock.iscltv = false;
      if (newTimeLock.locktime & SEQUENCE_LOCKTIME_TYPE_FLAG) { // Time-based lock
        // Convert to real seconds
        newTimeLock.locktime = (newTimeLock.locktime & SEQUENCE_LOCKTIME_MASK) << SEQUENCE_LOCKTIME_GRANULARITY;
        newTimeLock.istimebased = true;
        lockCondition += "locked for a period of " + newTimeLock.locktime + " seconds";
      } else { // Block-based lock
        newTimeLock.istimebased = false;
        lockCondition += "locked within " + newTimeLock.locktime + " blocks";
      }
    }
    newTimeLock.description = "This address uses " + opcodeStr + ". Any coins sent to this address will be " + lockCondition;

    // Get current balance of timelock address
    find_address(newTimeLock.a_id, function(address) {
      if (address) {
        newTimeLock.balance = address.balance;
      }

      if (newTimeLock.iscltv) {
        // Save document
        newTimeLock.save(function(err) {
          if (err) {
            return cb(err);
          } else {
            return cb();
          }
        });
      } else {
        // Update csv utxo info, only for csv address
        AddressTx.find({a_id: newTimeLock.a_id}).sort({blockindex: 'asc'}).exec(function(err, address_tx){
          if (err) {
            return cb(err);
          } else {
            lib.syncLoop(address_tx.length, function (loop) {
              var i = loop.iteration();
              update_csvinfo(newTimeLock.a_id, address_tx[i].txid, newTimeLock.locktime, newTimeLock.istimebased, function(err) {
                loop.next();
              });
            }, function() {
              CsvInfo.find({a_id: newTimeLock.a_id, isused: false}).sort({timetouse_number: 'asc'}).limit(10).exec(function(err, csvinfo){
                newTimeLock.csvinfo = csvinfo
                // Save document
                newTimeLock.save(function(err) {
                  if (err) {
                    return cb(err);
                  } else {
                    return cb();
                  }
                });
              });
            });
          }
        });
      }
    });
  },

  //property: 'received' or 'balance'
  update_richlist: function(list, cb){
    if(list == 'received') {
      Address.find({}, 'a_id balance received').sort({received: 'desc'}).limit(100).exec(function(err, addresses){
        Richlist.updateOne({coin: settings.coin}, {
          received: addresses,
        }, function() {
          return cb();
        });
      });
    } else { //balance
      Address.find({}, 'a_id balance received').sort({balance: 'desc'}).limit(100).exec(function(err, addresses){
        Richlist.updateOne({coin: settings.coin}, {
          balance: addresses,
        }, function() {
          return cb();
        });
      });
    }
  },

  get_tx: function(txid, cb) {
    find_tx(txid, function(tx){
      return cb(tx);
    });
  },

  get_txs: function(block, cb) {
    var txs = [];
    lib.syncLoop(block.tx.length, function (loop) {
      var i = loop.iteration();
      find_tx(block.tx[i], function(tx){
        if (tx) {
          txs.push(tx);
          loop.next();
        } else {
          loop.next();
        }
      })
    }, function(){
      return cb(txs);
    });
  },

  create_txs: function(block, cb) {
    is_locked("db_index", function (exists) {
      if (exists) {
        console.log("db_index lock file exists...");
        return cb();
      } else {
        lib.syncLoop(block.tx.length, function (loop) {
          var i = loop.iteration();
          save_tx(block.tx[i], block.height, function(err){
            if (err) {
              loop.next();
            } else {
              //console.log('tx stored: %s', block.tx[i]);
              loop.next();
            }
          });
        }, function(){
          return cb();
        });
      }
    });
  },

  get_last_txs_ajax: function(start, length, min, cb) {
    Tx.find({'total': {$gte: min}}).count(function(err, count){
      Tx.find({'total': {$gte: min}}).sort({blockindex: -1}).skip(Number(start)).limit(Number(length)).exec(function(err, txs){
        if (err) {
          return cb(err);
        } else {
          return cb(txs, count);
        }
      });
    });
  },

  get_address_txs_ajax: function(hash, start, length, cb) {
    var totalCount = 0;
    AddressTx.find({a_id: hash}).count(function(err, count){
      if(err) {
        return cb(err);
      } else {
        totalCount = count;
        AddressTx.aggregate([
          { $match: { a_id: hash } },
          { $sort: {blockindex: -1} },
          { $skip: Number(start) },
          {
            $group: {
              _id: '',
              balance: { $sum: '$amount' }
            }
          },
          {
            $project: {
              _id: 0,
              balance: '$balance'
            }
          },
          { $sort: {blockindex: -1} }
        ], function (err,balance_sum) {
          if (err) {
            return cb(err);
          } else {
            AddressTx.find({a_id: hash}).sort({blockindex: -1}).skip(Number(start)).limit(Number(length)).exec(function (err, address_tx) {
              if (err) {
                return cb(err);
              } else {
                var txs = [];
                var count = address_tx.length;
                var running_balance = balance_sum.length > 0 ? balance_sum[0].balance : 0;

                var txs = [];

                lib.syncLoop(count, function (loop) {
                  var i = loop.iteration();
                  find_tx(address_tx[i].txid, function (tx) {
                    if (tx && !txs.includes(tx)) {
                      tx.balance = running_balance;
                      txs.push(tx);
                      loop.next();
                    } else if (!txs.includes(tx)) {
                      txs.push("1. Not found");
                      loop.next();
                    } else {
                      loop.next();
                    }
                    running_balance = running_balance - address_tx[i].amount;
                  })
                }, function () {
                  return cb(txs, totalCount);
                });
              }
            });
          }
        });
      }
    });
  },

  create_market: function(coin, exchange, market, cb) {
    var newMarkets = new Markets({
      market: market,
      coin: coin,
      exchange: exchange,
    });

    newMarkets.save(function(err) {
      if (err) {
        console.log(err);
        return cb();
      } else {
        console.log("initial markets entry created for %s", market);
        //console.log(newMarkets);
        return cb();
      }
    });
  },

  // checks market data exists for given market
  check_market: function(market, cb) {
    Markets.findOne({market: market}, function(err, exists) {
      if(exists) {
        return cb(market, true);
      } else {
        return cb(market, false);
      }
    });
  },

  // gets market data for given market
  get_market: function(market, cb) {
    Markets.findOne({market: market}, function(err, data) {
      if(data) {
        return cb(data);
      } else {
        return cb(null);
      }
    });
  },

  // creates initial richlist entry in database; called on first launch of explorer
  create_richlist: function(coin, cb) {
    var newRichlist = new Richlist({
      coin: coin,
    });
    newRichlist.save(function(err) {
      if (err) {
        console.log(err);
        return cb();
      } else {
        console.log("initial richlist entry created for %s", coin);
        //console.log(newRichlist);
        return cb();
      }
    });
  },

  // drops richlist data for given coin
  delete_richlist: function(coin, cb) {
    Richlist.findOneAndRemove({coin: coin}, function(err, exists) {
      if(exists) {
        return cb(true);
      } else {
        return cb(false);
      }
    });
  },
  // checks richlist data exists for given coin
  check_richlist: function(coin, cb) {
    Richlist.findOne({coin: coin}, function(err, exists) {
      if(exists) {
        return cb(true);
      } else {
        return cb(false);
      }
    });
  },

  create_heavy: function(coin, cb) {
    var newHeavy = new Heavy({
      coin: coin,
    });
    newHeavy.save(function(err) {
      if (err) {
        console.log(err);
        return cb();
      } else {
        console.log("initial heavy entry created for %s", coin);
        console.log(newHeavy);
        return cb();
      }
    });
  },

  check_heavy: function(coin, cb) {
    Heavy.findOne({coin: coin}, function(err, exists) {
      if(exists) {
        return cb(true);
      } else {
        return cb(false);
      }
    });
  },

  get_heavy: function(coin, cb) {
    Heavy.findOne({coin: coin}, function(err, heavy) {
      if(heavy) {
        return cb(heavy);
      } else {
        return cb(null);
      }
    });
  },
  get_distribution: function(richlist, stats, cb){
    var distribution = {
      supply: stats.supply,
      t_1_25: {percent: 0, total: 0 },
      t_26_50: {percent: 0, total: 0 },
      t_51_75: {percent: 0, total: 0 },
      t_76_100: {percent: 0, total: 0 },
      t_101plus: {percent: 0, total: 0 }
    };
    lib.syncLoop(richlist.balance.length, function (loop) {
      var i = loop.iteration();
      var count = i + 1;
      var percentage = ((richlist.balance[i].balance / 1000000) / stats.supply) * 100;
      if (count <= 25 ) {
        distribution.t_1_25.percent = distribution.t_1_25.percent + percentage;
        distribution.t_1_25.total = distribution.t_1_25.total + (richlist.balance[i].balance / 1000000);
      }
      if (count <= 50 && count > 25) {
        distribution.t_26_50.percent = distribution.t_26_50.percent + percentage;
        distribution.t_26_50.total = distribution.t_26_50.total + (richlist.balance[i].balance / 1000000);
      }
      if (count <= 75 && count > 50) {
        distribution.t_51_75.percent = distribution.t_51_75.percent + percentage;
        distribution.t_51_75.total = distribution.t_51_75.total + (richlist.balance[i].balance / 1000000);
      }
      if (count <= 100 && count > 75) {
        distribution.t_76_100.percent = distribution.t_76_100.percent + percentage;
        distribution.t_76_100.total = distribution.t_76_100.total + (richlist.balance[i].balance / 1000000);
      }
      loop.next();
    }, function(){
      distribution.t_101plus.percent = parseFloat(100 - distribution.t_76_100.percent - distribution.t_51_75.percent - distribution.t_26_50.percent - distribution.t_1_25.percent).toFixed(2);
      distribution.t_101plus.total = parseFloat(distribution.supply - distribution.t_76_100.total - distribution.t_51_75.total - distribution.t_26_50.total - distribution.t_1_25.total).toFixed(8);
      distribution.t_1_25.percent = parseFloat(distribution.t_1_25.percent).toFixed(2);
      distribution.t_1_25.total = parseFloat(distribution.t_1_25.total).toFixed(8);
      distribution.t_26_50.percent = parseFloat(distribution.t_26_50.percent).toFixed(2);
      distribution.t_26_50.total = parseFloat(distribution.t_26_50.total).toFixed(8);
      distribution.t_51_75.percent = parseFloat(distribution.t_51_75.percent).toFixed(2);
      distribution.t_51_75.total = parseFloat(distribution.t_51_75.total).toFixed(8);
      distribution.t_76_100.percent = parseFloat(distribution.t_76_100.percent).toFixed(2);
      distribution.t_76_100.total = parseFloat(distribution.t_76_100.total).toFixed(8);
      return cb(distribution);
    });
  },
  // updates heavy stats for coin
  // height: current block height, count: amount of votes to store
  update_heavy: function(coin, height, count, cb) {
    var newVotes = [];
    lib.get_maxmoney( function (maxmoney) {
      lib.get_maxvote( function (maxvote) {
        lib.get_vote( function (vote) {
          lib.get_phase( function (phase) {
            lib.get_reward( function (reward) {
              lib.get_supply( function (supply) {
                lib.get_estnext( function (estnext) {
                  lib.get_nextin( function (nextin) {
                    lib.syncLoop(count, function (loop) {
                      var i = loop.iteration();
                      lib.get_blockhash(height-i, function (hash) {
                        lib.get_block(hash, function (block) {
                          newVotes.push({count:height-i,reward:block.reward,vote:block.vote});
                          loop.next();
                        });
                      });
                    }, function(){
                      console.log(newVotes);
                      Heavy.updateOne({coin: coin}, {
                        lvote: vote,
                        reward: reward,
                        supply: supply,
                        cap: maxmoney,
                        estnext: estnext,
                        phase: phase,
                        maxvote: maxvote,
                        nextin: nextin,
                        votes: newVotes,
                      }, function() {
                        //console.log('address updated: %s', hash);
                        return cb();
                      });
                    });
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
  update_markets_db: function(market, cb) {
    get_market_data(market, function (err, obj) {
      if (err == null) {
        Markets.updateOne({market:market}, {
          chartdata: JSON.stringify(obj.chartdata),
          buys: obj.buys,
          sells: obj.sells,
          history: obj.trades,
          summary: obj.stats,
        }, function() {
          if ( market == settings.markets.default ) {
            Stats.updateOne({coin:settings.coin}, {
              last_price: obj.stats.last,
            }, function(){
              return cb(null);
            });
          } else {
            return cb(null);
          }
        });
      } else {
        return cb(err);
      }
    });
  },

  // updates stats data for given coin; called by sync.js
  update_db: function(coin, cb) {
    lib.get_blockcount( function (count) {
      console.log("TACA database.js ===> call lib.get_blockcount successfully");
      if (!count){
        console.log('Unable to connect to explorer API');
        return cb(false);
      }
      lib.get_supply( function (supply){
        console.log("TACA datbase.js ===> call lib.get_supply successfully");
        lib.get_connectioncount(function (connections) {
          console.log("TACA database.js ===> call lib.get_connectioncount successfully");
          Stats.findOneAndUpdate({coin: coin}, {
            $set: {
              coin: coin,
              count : count,
              supply: supply,
              connections: connections
            }
          }, {
            new: true
          }, function(err, new_stats) {
            if(err) {
              console.log("Error during Stats Update:", err);
            }
            var last_temp = new_stats.last ? new_stats.last : 0;
            console.log("TACA database.js ===> update StatsCollection, coin = %s, count = %s, supply = %s, connections = %s, last = %s", coin, count, supply, connections, last_temp);
            return cb({coin: coin,
              count : count,
              supply: supply,
              connections: connections,
              last: last_temp});
          });
        });
      });
    });
  },

  // updates tx, address & richlist db's; called by sync.js
  update_tx_mempool: function(block_height, timeout, cb) {
    console.log("TACA database.js, update_tx_mempool ===> call lib.get_rawmempool for block_height = %s", block_height);
    lib.get_rawmempool(function(txid_mempool) {
      // First txid is the latest one so reverse it
      txid_mempool.reverse()
      // Refer block format http://explorer.yacoin.org/api/getblock?hash=000003aa811cab7a4c778ed496d7111dd20ea2d446a76cd22fcd047091d47390
      async.eachLimit(txid_mempool, 1, function(txid, next_tx) {
        AddressUtxoMempool.findOne({blockheight: block_height, txid: txid}, function(err, tx) {
          if(tx) {
            setTimeout( function(){
              tx = null;
              next_tx();
            }, timeout);
          } else {
            console.log("TACA database.js, update_tx_mempool ===> call save_tx_mempool for txid %s of block_height = %s", txid, block_height);
            save_tx_mempool(txid, block_height, function(err){
              if (err) {
                console.log(err);
              } else {
                console.log('%s: %s', block_height, txid);
              }
              setTimeout( function(){
                tx = null;
                next_tx();
              }, timeout);
            });
          }
        });
      }, function(){
        remove_lock("db_index", function(){
          return cb();
        });
      });
    });
  },

  update_tx_db: function(coin, start, end, timeout, cb) {
    is_locked("db_index", function (exists) {
      if (exists) {
        console.log("db_index lock file exists...");
        return cb();
      } else {
        create_lock("db_index", function (){
          if (start < 1) { start = 1; }
          var complete = false;
          var blocks_to_scan = [];
          var task_limit_blocks = settings.block_parallel_tasks;
          if (task_limit_blocks < 1) { task_limit_blocks = 1; }
          var task_limit_txs = 1;
          for (i=start; i<(end+1); i++) {
            blocks_to_scan.push(i);
          }
          console.log("TACA database.js, update_tx_db ===> update_tx_db, scan from block %s to %s", start, end);
          async.eachLimit(blocks_to_scan, task_limit_blocks, function(block_height, next_block) {
            if (block_height % 5000 === 0) {
              console.log("TACA database.js, update_tx_db ===> update stats database with last = %s", block_height - 1);
              Stats.updateOne({coin: coin}, {
                last: block_height - 1,
                last_txs: '' //not used anymore left to clear out existing objects
              }, function() {});
            }
            console.log("TACA database.js, update_tx_db ===> call lib.get_blockhash for block_height = %s", block_height);
            lib.get_blockhash(block_height, function(blockhash){
              if (blockhash) {
                console.log("TACA database.js, update_tx_db ===> call lib.get_block for block_height = %s", block_height);
                lib.get_block(blockhash, function(block) {
                  if (block) {
                    // Refer block format http://explorer.yacoin.org/api/getblock?hash=000003aa811cab7a4c778ed496d7111dd20ea2d446a76cd22fcd047091d47390
                    async.eachLimit(block.tx, task_limit_txs, function(txid, next_tx) {
                      Tx.findOne({txid: txid}, function(err, tx) {
                        if(tx) {
                          setTimeout( function(){
                            tx = null;
                            next_tx();
                          }, timeout);
                        } else {
                          console.log("TACA database.js, update_tx_db ===> call save_tx for txid %s of block_height = %s", txid, block_height);
                          save_tx(txid, block_height, function(err){
                            if (err) {
                              console.log(err);
                            } else {
                              console.log('%s: %s', block_height, txid);
                            }
                            setTimeout( function(){
                              tx = null;
                              next_tx();
                            }, timeout);
                          });
                        }
                      });
                    }, function(){
                      setTimeout( function(){
                        blockhash = null;
                        block = null;
                        next_block();
                      }, timeout);
                    });
                  } else {
                    console.log('block not found: %s', blockhash);
                    setTimeout( function(){
                      next_block();
                    }, timeout);
                  }
                });
              } else {
                setTimeout( function(){
                  next_block();
                }, timeout);
              }
            });
          }, function(){
            console.log("TACA database.js, update_tx_db ===> updated all blocks, sort tx db, update stats db");
            Tx.find({}).sort({timestamp: 'desc'}).limit(settings.index.last_txs).exec(function(err, txs){
              Stats.updateOne({coin: coin}, {
                last: end,
                last_txs: '' //not used anymore left to clear out existing objects
              }, function() {
                remove_lock("db_index", function(){
                  return cb();
                });
              });
            });
          });
        });
      }
    });
  },

  create_peer: function(params, cb) {
    var newPeer = new Peers(params);
    newPeer.save(function(err) {
      if (err) {
        console.log(err);
        return cb();
      } else {
        return cb();
      }
    });
  },

  find_peer: function(address, cb) {
    Peers.findOne({address: address}, function(err, peer) {
      if (err) {
        return cb(null);
      } else {
        if (peer) {
         return cb(peer);
       } else {
         return cb (null)
       }
      }
    })
  },

  drop_peer: function(address, cb) {
    Peers.deleteOne({address: address}, function(err) {
      if (err) {
        console.log(err);
        return cb();
      } else {
        return cb ()
      }
    })
  },

  drop_peers: function(cb) {
    Peers.deleteMany({}, function(err) {
      if (err) {
        console.log(err);
        return cb();
      } else {
        return cb ()
      }
    })
  },

  get_peers: function(cb) {
    Peers.find({}, function(err, peers) {
      if (err) {
        return cb([]);
      } else {
        return cb(peers);
      }
    });
  }
};
