#!/bin/bash
cd /explorer
npm start &
mempool_sleep=5
update_block_sleep=60
sleep_count=0
while true; do
    sleep $mempool_sleep
    ulimit -s 10240
    rm -f tmp/index.pid && node --stack-size=10240 scripts/sync.js index mempool
    ((sleep_count=$sleep_count+$mempool_sleep))
    if ((sleep_count >= update_block_sleep)); then
	ulimit -s 10240
        rm -f tmp/index.pid && node --stack-size=10240 scripts/sync.js index update
	sleep_count=0
    fi
done
