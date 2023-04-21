var express = require('express'),
  path = require('path'),
  bitcoinapi = require('bitcoin-node-api'),
  favicon = require('static-favicon'),
  logger = require('morgan'),
  cookieParser = require('cookie-parser'),
  bodyParser = require('body-parser'),
  settings = require('./lib/settings'),
  routes = require('./routes/index'),
  lib = require('./lib/explorer'),
  db = require('./lib/database'),
  package_metadata = require('./package.json'),
  locale = require('./lib/locale'),
  request = require('request');

var app = express();
const util = require('util');
const cors = require('cors');

// bitcoinapi
bitcoinapi.setWalletDetails(settings.wallet);
if (settings.heavy != true) {
  bitcoinapi.setAccess('only', [
    'getinfo',
    'getnetworkhashps',
    'getmininginfo',
    'getdifficulty',
    'getconnectioncount',
    'getblockcount',
    'getblockhash',
    'getblock',
    'getrawtransaction',
    'getpeerinfo',
    'gettxoutsetinfo',
    'verifymessage',
  ]);
} else {
  // enable additional heavy api calls
  /*
    getvote - Returns the current block reward vote setting.
    getmaxvote - Returns the maximum allowed vote for the current phase of voting.
    getphase - Returns the current voting phase ('Mint', 'Limit' or 'Sustain').
    getreward - Returns the current block reward, which has been decided democratically in the previous round of block reward voting.
    getnextrewardestimate - Returns an estimate for the next block reward based on the current state of decentralized voting.
    getnextrewardwhenstr - Returns string describing how long until the votes are tallied and the next block reward is computed.
    getnextrewardwhensec - Same as above, but returns integer seconds.
    getsupply - Returns the current money supply.
    getmaxmoney - Returns the maximum possible money supply.
  */
  bitcoinapi.setAccess('only', [
    'getinfo',
    'getstakinginfo',
    'getnetworkhashps',
    'getdifficulty',
    'getconnectioncount',
    'getblockcount',
    'getblockhash',
    'getblock',
    'getrawtransaction',
    'getmaxmoney',
    'getvote',
    'getmaxvote',
    'getphase',
    'getreward',
    'getnextrewardestimate',
    'getnextrewardwhenstr',
    'getnextrewardwhensec',
    'getsupply',
    'gettxoutsetinfo',
    'verifymessage',
  ]);
}
// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'pug');

app.use(
  cors({
    origin: '*',
  })
);
app.use(favicon(path.join(__dirname, settings.favicon)));
app.use(logger('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// routes
app.use('/api/address/:address/utxo', function (req, res) {
  lib.get_blockcount(function (blockheight) {
    db.get_utxo_mempool(blockheight, req.params.address, function (found, utxo_mempool) {
      var return_info = [];
      if (found) {
        for (var i = 0; i < utxo_mempool.length; i++) {
          info = {
            txid: utxo_mempool[i].txid,
            vout: utxo_mempool[i].vout,
            value: utxo_mempool[i].amount,
            status: {
              confirmed: true,
              block_height: utxo_mempool[i].blockutxoheight,
            },
          };
          return_info.push(info);
        }
        res.send(return_info);
      } else {
        db.get_utxo(req.params.address, function (utxo) {
          lib.syncLoop(
            utxo.length,
            function (loop) {
              // Update balance and transaction of addresses used as vin
              var i = loop.iteration();

              db.get_tx(utxo[i].txid, function (tx) {
                info = {
                  txid: utxo[i].txid,
                  vout: utxo[i].vout,
                  value: utxo[i].amount,
                  status: {
                    confirmed: true,
                    block_height: tx.blockindex,
                    block_hash: tx.blockhash,
                    block_time: tx.timestamp,
                  },
                };
                return_info.push(info);
                loop.next();
              });
            },
            function () {
              res.send(return_info);
            }
          );
        });
      }
    });
  });
});

app.use('/api/address/:address', function (req, res) {
  lib.get_blockcount(function (blockheight) {
    db.get_utxo_mempool_info(blockheight, req.params.address, function (utxo_mempool_info, new_txcount) {
      if (utxo_mempool_info) {
        db.get_txcount(req.params.address, function (txcount) {
          return_info = {
            address: req.params.address,
            ...utxo_mempool_info,
            tx_count: txcount + new_txcount,
          };
          res.send(return_info);
        });
      } else {
        db.get_utxo_info(req.params.address, function (utxo_info) {
          db.get_txcount(req.params.address, function (txcount) {
            return_info = {
              address: req.params.address,
              ...utxo_info,
              tx_count: txcount,
            };
            res.send(return_info);
          });
        });
      }
    });
  });
});

app.use('/api/tx/:txid/hex', function (req, res) {
  lib.get_rawtransaction(
    req.params.txid,
    function (tx) {
      res.send(tx);
    },
    0
  );
});

app.use('/api/tx/:txid', function (req, res) {
  var return_info = {};
  lib.get_rawtransaction(req.params.txid, function (tx) {
    return_info.hex = tx.hex;
    return_info.block_hash = tx.blockhash;
    return_info.confirmations = tx.confirmations;

    db.get_tx(req.params.txid, function (tx_info) {
      if (tx_info) {
        return_info.block_height = tx_info.blockindex;
        lib.calculate_total(tx_info.vin, function (vin_total) {
          return_info.fee = vin_total - tx_info.total;
          res.send(return_info);
        });
      } else {
        return res.status(404).send({
          name: 'NodeError',
          message: 'Transaction not found',
        });
      }
    });
  });
});

app.post('/api/tx', function (req, res) {
  lib.send_rawtransaction(req.body.data, function (response) {
    res.json(response);
  });
});

app.use('/api', bitcoinapi.app);
app.use('/', routes);
app.use('/ext/getmoneysupply', function (req, res) {
  lib.get_supply(function (supply) {
    res.send(' ' + supply);
  });
});

app.use('/ext/getaddress/:hash', function (req, res) {
  db.get_address(req.params.hash, function (address) {
    db.get_address_txs_ajax(req.params.hash, 0, settings.txcount, function (txs, count) {
      if (address) {
        var last_txs = [];
        for (i = 0; i < txs.length; i++) {
          if (typeof txs[i].txid !== 'undefined') {
            var out = 0,
              vin = 0,
              tx_type = 'vout',
              row = {};
            txs[i].vout.forEach(function (r) {
              if (r.addresses == req.params.hash) {
                out += r.amount;
              }
            });
            txs[i].vin.forEach(function (s) {
              if (s.addresses == req.params.hash) {
                vin += s.amount;
              }
            });
            if (vin > out) {
              tx_type = 'vin';
            }
            row['addresses'] = txs[i].txid;
            row['type'] = tx_type;
            last_txs.push(row);
          }
        }
        var a_ext = {
          address: address.a_id,
          sent: address.sent / 1000000,
          received: address.received / 1000000,
          balance: (address.balance / 1000000).toString().replace(/(^-+)/gm, ''),
          last_txs: last_txs,
        };
        res.send(a_ext);
      } else {
        res.send({ error: 'address not found.', hash: req.params.hash });
      }
    });
  });
});

app.use('/ext/gettx/:txid', function (req, res) {
  var txid = req.params.txid;
  db.get_tx(txid, function (tx) {
    if (tx) {
      lib.get_blockcount(function (blockcount) {
        res.send({ active: 'tx', tx: tx, confirmations: settings.confirmations, blockcount: blockcount });
      });
    } else {
      lib.get_rawtransaction(txid, function (rtx) {
        if (rtx.txid) {
          lib.prepare_vin(rtx, function (vin) {
            lib.prepare_vout(rtx.vout, rtx.txid, vin, function (rvout, rvin) {
              lib.calculate_total(rvout, function (total) {
                if (!rtx.confirmations > 0) {
                  var utx = {
                    txid: rtx.txid,
                    vin: rvin,
                    vout: rvout,
                    total: total.toFixed(8),
                    timestamp: rtx.time,
                    blockhash: '-',
                    blockindex: -1,
                  };
                  res.send({ active: 'tx', tx: utx, confirmations: settings.confirmations, blockcount: -1 });
                } else {
                  var utx = {
                    txid: rtx.txid,
                    vin: rvin,
                    vout: rvout,
                    total: total.toFixed(8),
                    timestamp: rtx.time,
                    blockhash: rtx.blockhash,
                    blockindex: rtx.blockheight,
                  };
                  lib.get_blockcount(function (blockcount) {
                    res.send({ active: 'tx', tx: utx, confirmations: settings.confirmations, blockcount: blockcount });
                  });
                }
              });
            });
          });
        } else {
          res.send({ error: 'tx not found.', hash: txid });
        }
      });
    }
  });
});

app.use('/ext/getbalance/:hash', function (req, res) {
  db.get_address(req.params.hash, function (address) {
    if (address) {
      res.send((address.balance / 1000000).toString().replace(/(^-+)/gm, ''));
    } else {
      res.send({ error: 'address not found.', hash: req.params.hash });
    }
  });
});

app.use('/ext/getdistribution', function (req, res) {
  db.get_richlist(settings.coin, function (richlist) {
    db.get_stats(settings.coin, function (stats) {
      db.get_distribution(richlist, stats, function (dist) {
        res.send(dist);
      });
    });
  });
});

app.use('/ext/getlasttxsajax/:min', function (req, res) {
  if (
    typeof req.query.length === 'undefined' ||
    isNaN(req.query.length) ||
    req.query.length > settings.index.last_txs
  ) {
    req.query.length = settings.index.last_txs;
  }
  if (typeof req.query.start === 'undefined' || isNaN(req.query.start) || req.query.start < 0) {
    req.query.start = 0;
  }
  if (typeof req.params.min === 'undefined' || isNaN(req.params.min) || req.params.min < 0) {
    req.params.min = 0;
  } else {
    req.params.min = req.params.min * 1000000;
  }
  db.get_last_txs_ajax(req.query.start, req.query.length, req.params.min, function (txs, count) {
    var data = [];
    for (i = 0; i < txs.length; i++) {
      var row = [];
      row.push(txs[i].blockindex);
      row.push(txs[i].blockhash);
      row.push(txs[i].txid);
      row.push(txs[i].vout.length);
      row.push(txs[i].total);
      row.push(new Date(txs[i].timestamp * 1000).toUTCString());
      data.push(row);
    }
    res.json({ data: data, draw: req.query.draw, recordsTotal: count, recordsFiltered: count });
  });
});

app.use('/ext/getaddresstxsajax/:address', function (req, res) {
  req.query.length = parseInt(req.query.length);
  if (isNaN(req.query.length) || req.query.length > settings.txcount) {
    req.query.length = settings.txcount;
  }
  if (isNaN(req.query.start) || req.query.start < 0) {
    req.query.start = 0;
  }
  db.get_address_txs_ajax(req.params.address, req.query.start, req.query.length, function (txs, count) {
    var data = [];
    for (i = 0; i < txs.length; i++) {
      if (typeof txs[i].txid !== 'undefined') {
        var out = 0;
        var vin = 0;

        txs[i].vout.forEach(function (r) {
          if (r.addresses == req.params.address) {
            out += r.amount;
          }
        });

        txs[i].vin.forEach(function (s) {
          if (s.addresses == req.params.address) {
            vin += s.amount;
          }
        });

        var row = [];
        row.push(new Date(txs[i].timestamp * 1000).toUTCString());
        row.push(txs[i].txid);
        row.push(out);
        row.push(vin);
        row.push(txs[i].balance);
        data.push(row);
      }
    }

    res.json({ data: data, draw: req.query.draw, recordsTotal: count, recordsFiltered: count });
  });
});

app.post('/address/:hash/claim', function (req, res) {
  var address = req.body.address;
  var signature = req.body.signature;
  var message = req.body.message;
  request(
    {
      url:
        'http://127.0.0.1:' +
        settings.port +
        '/api/verifymessage?address=' +
        address +
        '&signature=' +
        signature +
        '&message=' +
        message,
      method: 'GET',
    },
    function (error, response, body) {
      //console.log('error', error);
      //console.log('response', response);
      if (body == 'false') {
        console.log('failed');
        res.json({ status: 'failed', error: true, message: error });
      } else if (body == 'true') {
        db.update_label(address, message, function () {
          res.json({ status: 'success' });
        });
      }
    }
  );
});

app.use('/ext/connections', function (req, res) {
  db.get_peers(function (peers) {
    res.send({ data: peers });
  });
});

// locals
app.set('title', settings.title);
app.set('iquidus_version', package_metadata.version);
app.set('symbol', settings.symbol);
app.set('coin', settings.coin);
app.set('locale', locale);
app.set('display', settings.display);
app.set('markets', settings.markets);
app.set('twitter', settings.twitter);
app.set('facebook', settings.facebook);
app.set('googleplus', settings.googleplus);
app.set('youtube', settings.youtube);
app.set('genesis_block', settings.genesis_block);
app.set('index', settings.index);
app.set('use_rpc', settings.use_rpc);
app.set('heavy', settings.heavy);
app.set('lock_during_index', settings.lock_during_index);
app.set('txcount', settings.txcount);
app.set('txcount_per_page', settings.txcount_per_page);
app.set('nethash', settings.nethash);
app.set('nethash_units', settings.nethash_units);
app.set('show_sent_received', settings.show_sent_received);
app.set('logo', settings.logo);
app.set('headerlogo', settings.headerlogo);
app.set('theme', settings.theme);
app.set('labels', settings.labels);

// catch 404 and forward to error handler
app.use(function (req, res, next) {
  var err = new Error('Not Found');
  err.status = 404;
  next(err);
});

// development error handler
// will print stacktrace
if (app.get('env') === 'development') {
  app.use(function (err, req, res, next) {
    res.status(err.status || 500);
    res.render('error', {
      message: err.message,
      error: err,
    });
  });
}

// production error handler
// no stacktraces leaked to user
app.use(function (err, req, res, next) {
  res.status(err.status || 500);
  res.render('error', {
    message: err.message,
    error: {},
  });
});

module.exports = app;
