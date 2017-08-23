// For processing
let   registrants         = []
      transactions        = []
      reclaimable         = {} //index

// For Export
let   output              = {}
      output.distribution = []
      output.reclaimable  = []
      output.reclaimed    = []
      output.rejects      = []
      output.logs         = []

// Ethereum
const Web3                = require('web3')
let   web3                = new Web3( new Web3.providers.HttpProvider( NODE ) )

let   contract            = {}
      contract.$crowdsale = web3.eth.contract(CROWDSALE_ABI).at(CROWDSALE_ADDRESS)
      contract.$token     = web3.eth.contract(TOKEN_ABI).at(TOKEN_ADDRESS)
      contract.$utilities = web3.eth.contract(UTILITY_ABI).at(UTILITY_ADDRESS)

// Debugging
let   debug               = new calculator();

window.onload = () => { init() }

const init = () => {
  log("large_text", 'EOS Token Distribution (testnet)')
  
  SS_PERIOD_ETH         = period_eth_balance()
  SS_LAST_BLOCK_TIME    = get_last_block_time()
  
  if( !web3.isConnected() ) 
    log("error", 'web3 is disconnected'), log("info", 'Please make sure you have a local ethereum node runnning on localhost:8345'), disconnected( init ) 
  else if( !is_synced() )
    log("error", 'web3 is still syncing, retrying in 10 seconds'), node_syncing( init )
  else
    async.series([ 
      scan_registry, 
      find_reclaimables, 
      distribute_tokens, 
      verify,
      exported
    ], 
    ( error, results ) => {
      if(!error) {
        log("success",'Distribution List Complete')
        log('block','CSV Downloads Ready')
      }
      debug.refresh().output()
    })
}


//Sets balances, validates registrant, adds to distribution if good  
const distribute_tokens = ( finish ) => {
  
  log('group', 'Distribution List')
  
  let   index = 0
  const total = registrants.length
  
  const iterate = () => {

    if( !web3.isConnected() ) return disconnected( reconnect = iterate )

    // try {

      // console.time('Distribute')
      
      let registrant = registrants[index]

      registrant.index = index
      
      registrant.eos = maybe_fix_key(  contract.$crowdsale.keys( registrant.eth ) ) 
      
      // Every registrant has three different balances, 
      // Wallet:      Tokens in Wallet
      // Unclaimed:   Tokens in contract
      // Reclaimed:   Tokens sent to crowdsale/token contracts

      registrant.balance

        // Ask token contract what this user's EOS balance is
        .set( 'wallet',      web3.toBigNumber( contract.$token.balanceOf( registrant.eth ).div(WAD) ) )
        
        // Loop through periods and calculate unclaimed
        .set( 'unclaimed',   web3.toBigNumber( sum_unclaimed( registrant ) ).div(WAD) )
        
        // Check reclaimable index for ethereum user, loop through tx
        .set( 'reclaimed',   web3.toBigNumber( maybe_reclaim_tokens( registrant ) ).div(WAD) )

        // wallet+unclaimed+reclaimed
        .sum()
      
      // Reject or Accept
      registrant.test()

      status_log()

      // Runaway loops, calls iterate again or calls finish() callback from async
      setTimeout(() => {  
        index++,  
        ( index < total ) ? iterate() : ( 
          console.groupEnd(), 
          finish(null, true) 
        ) 
      }, 1 )

    // }

    // // This error is web3 related, try again and resume if successful
    // catch(e) {
    //   log("error", e);   
    //   if( !web3.isConnected() ) {
    //     log("message",`Attempting reconnect once per second, will resume from registrant ${index}`)
    //     disconnected( reconnect = iterate )
    //   }
    // }

    // finally {
    //   // console.timeEnd('Distribute')
    // }

  }

  const sum_unclaimed = ( registrant ) => {

    //Find all Buys
    let buys   = contract.$utilities.userBuys(registrant.eth).map(web3.toBigNumber)

    //Find Claimed Balances
    let claims = contract.$utilities.userClaims(registrant.eth)

    //Compile the periods, and user parameters for each period for later reduction
    const periods = iota(Number(CS_NUMBER_OF_PERIODS) + 1).map(i => {
      let period = {}
      period.tokens_available = web3.toBigNumber( period == 0 ? CS_CREATE_FIRST_PERIOD : CS_CREATE_PER_PERIOD )  
      period.total_eth  = SS_PERIOD_ETH[i]
      period.buys = buys[i] && buys[i]
      period.share = !period.buys || period.total_eth.equals(0)
        ? web3.toBigNumber(0)
        : period.tokens_available.div(period.total_eth).times(period.buys)   
      period.claimed = claims && claims[i]
      return period  

    })

    return web3
      .toBigNumber(periods

        //Get periods by unclaimed and lte last block
        .filter((period, i) => { return i <= period_for(SS_LAST_BLOCK_TIME) && !period.claimed })

        //Sum the pre-calculated EOS balance of each resulting period
        .reduce((sum, period) => period.share.plus(sum), web3.toBigNumber(0) )

      )
  }

  //Some keys are fixable
  const maybe_fix_key = ( eos_key ) => {

    //Might be hex, convert it.
    if(eos_key.length == 106){                                    
      let eos_key_from_hex = web3.toAscii(eos_key) 
      if(eos_key_from_hex.startsWith('EOS') && eos_key_from_hex.length == 53) { 
        eos_key = eos_key_from_hex
      } 
    }

    //Might be user error
    else if(eos_key.startsWith('key')){                            
      let eos_key_mod = eos_key.substring(3) 
      if(eos_key_mod.startsWith('EOS') && eos_key_mod.length == 53) {
        eos_key = eos_key_mod
      } 
    }

    return eos_key

  }

  // Some users mistakenly sent their tokens to the contract or token address. Here we recover them if it is the case. 
  const maybe_reclaim_tokens = ( registrant ) => {
    let reclaimed_balance = web3.toBigNumber(0)
    // let reclaimable_transactions = reclaimable[registrant.eth];
    let reclaimable_transactions = get_registrant_reclaimable( registrant.eth )
    if(reclaimable_transactions.length) {
      for( let tx of reclaimable_transactions ) {
        // let tx = reclaimable_transactions[_tx]
        reclaimed_balance = tx.amount.plus( reclaimed_balance )
        tx.claim( registrant.eth )
        tx.eos = registrant.eos
        log("success", `reclaimed ${registrant.eth} => ${registrant.eos} => ${tx.amount.div(WAD).toFormat(4)} EOS <<< tx: https://etherscan.io/tx/${tx.hash}`)
      }
      if( reclaimable_transactions.length > 1 ) 
        log("info", `Reclaimed ${ reclaimed_balance.div(WAD).toFormat(4) } EOS from ${reclaimable_transactions.length} tx for ${registrant.eth} => ${registrant.eos}`)
      // delete reclaimable[registrant.eth]
    }
    return reclaimed_balance
  }

  const status_log = () => {
    if(index % UI_SHOW_STATUS_EVERY == 0 && index != 0) debug.refresh(), 
      console.group("Snapshot Status"),
      log("success",  `Progress:      EOS ${debug.rates.percent_complete}% `),
      log("success",  `Unclaimed:     EOS ${debug.distribution.$balance_unclaimed.toFormat(4) }`),
      log("success",  `In Wallets:    EOS ${debug.distribution.$balance_wallets.toFormat(4)}`),
      log("success",  `Reclaimed:     EOS ${debug.distribution.$balance_reclaimed.toFormat(4)}`),
      log("success",  `Total:         EOS ${debug.distribution.$balances_found.toFormat(4)}`),
      log("error",    `Rejected:      EOS ${debug.rejected.$total.toFormat(4) }`),
      log("error",    `Reclaimable:   EOS ${debug.distribution.$balance_reclaimable.toFormat(4) }`),
      log("error",    `Not Included:  EOS ${debug.distribution.$balances_missing.toFormat(4) }`),
    console.groupEnd()
  }

  iterate()

}

// Crowdsale contract didnt store registrants in an array, so we need to scrap LogRegister using a polling function :/ 

// Builds Registrants List
const scan_registry = ( on_complete ) => {

  console.group('EOS Registrant List')

  let registry_logs = [];
  let message_freq = 10000;
  let last_message = Date.now();

  let group_index = 1;

  const on_result = ( log_register ) => { 

    //Since this is a watcher, we need to be sure the result isn't new. 
    if(log_register.blockNumber <= SS_LAST_BLOCK) {

      //check that registrant isn't already in array
      if( registrant = registrants.filter(registrant => { return registrant.eth == log_register.args.user}), !registrant.length ){  
        
        //Create new registrant and add to registrants array (global)
        registrants.push( registrant = new Registrant(log_register.args.user) ) 

        let tx = new Transaction( registrant.eth, log_register.transactionHash, 'register', web3.toBigNumber(0) )

        transactions.push(tx)

        registry_logs.push(`${registrant.eth} => ${log_register.args.key} (pending) => https://etherscan.io/tx/${tx.hash}`)

        maybe_log()

      }
    }
  }

  const on_success = () => { 
      debug.refresh(), 
      log_group(), 
      console.groupEnd(), 
      log("block",`${registrants.length} Total Registrants`), 
      { found: Object.keys(registrants).length } 
    }

  const on_error = () => { "Web3's watcher misbehaved while chugging along in the registry" }

  let maybe_log = () => {
    return (Date.now()-message_freq > last_message) ? (log_group(), true) : false
  }

  let log_group = () => {
    let group_msg = `${group_index}. ... ${registry_logs.length} Found, Total: ${registrants.length}`;
    log("groupCollapsed", group_msg),
    output.logs.push( group_msg ),
    registry_logs.forEach( _log => { 
      if(VERBOSE_REGISTRY_LOGS) log("message", _log ) 
      output.logs.push( _log )
    }), 
    registry_logs = [],
    console.groupEnd(),
    group_index++,
    last_message = Date.now()
  }

  let async_watcher = LogWatcher(  SS_FIRST_BLOCK, SS_LAST_BLOCK, contract.$crowdsale.LogRegister, null, on_complete, on_result, on_success, on_error, 2500, 5000)
}


//Builds list of EOS tokens sent to EOS crowdsale or token contract.

const find_reclaimables = ( on_complete ) => {

  log('group', 'Finding Reclaimable EOS Tokens')

  let index = 0;

  const query = { to: ['0x86fa049857e0209aa7d9e616f7eb3b3b78ecfdb0','0xd0a6E6C54DbC68Db5db3A091B171A77407Ff7ccf'] }

  const on_result = ( reclaimable_tx ) => {  

    if(reclaimable_tx.blockNumber <= SS_LAST_BLOCK && reclaimable_tx.args.value.gt( web3.toBigNumber(0) )) {
      
      // if(typeof reclaimable[reclaimable_tx.args.from] === "undefined") reclaimable[reclaimable_tx.args.from] = []
    
      let tx = new Transaction( reclaimable_tx.args.from, reclaimable_tx.transactionHash, 'transfer', reclaimable_tx.args.value )

      transactions.push(tx)

      // reclaimable[tx.eth].push( tx ) 
    
      log("error",`${tx.eth} => ${web3.toBigNumber(tx.amount).div(WAD)} https://etherscan.io/tx/${tx.hash}`)
    
    }

  }

  const on_success = () => { 
    debug.refresh(), 
      console.groupEnd(), 
      log("block", `${Object.keys(reclaimable).length || 0} reclaimable transactions found`), 
      { found: Object.keys(reclaimable).length } 
  }

  const on_error = () => { "Something bad happened while finding reclaimables" }

  let async_watcher = LogWatcher( SS_FIRST_BLOCK, SS_LAST_BLOCK, contract.$token.Transfer, query, on_complete, on_result, on_success, on_error, 500, 5000 )

}

const verify = ( callback ) => {
  let valid = true;
  if( ![...new Set( get_registrants_accepted().map(registrant => registrant.eth) )].length == get_registrants_accepted().length ) log("error",'Duplicate Entry Found'), valid = false
  return (valid) ? callback(null, valid) && true : callback(true) && false
}

const exported = ( callback ) => {
  output.reclaimable = get_transactions_reclaimable().map( tx => { return { eth: tx.eth, tx: tx.hash, amount: formatEOS(web3.toBigNumber(tx.amount).div(WAD)) } } )
  output.reclaimed   = get_transactions_reclaimed().map( tx => { return { eth: tx.eth, eos: tx.eos, tx: tx.hash, amount: formatEOS(web3.toBigNumber(tx.amount).div(WAD)) } } )
  output.snapshot    = get_registrants_accepted().map( registrant => { return { eth: registrant.eth, eos: registrant.eos, balance: formatEOS(registrant.balance.total) } } )
  output.rejects     = get_registrants_rejected().map( registrant => { return { error: registrant.error, eth: registrant.eth, eos: registrant.eos, balance: formatEOS(registrant.balance.total)}  } )
  // for( let registrant in reclaimable )  {
  //   reclaimable[registrant].map( tx => { return { eth: tx.eth, tx: tx.hash, amount: formatEOS(web3.toBigNumber(tx.amount).div(WAD)) } } ).forEach( tx => { output.reclaimable.push( tx ) })
  // }  
  callback(null, true)
} 