var async = require('async');
var request = require('request');
var influx = require('influx');
var humanizeDuration = require('humanize-duration')

// Config
var endpoint = 'https://api.guildwars2.com/v2';
var DbHost = 'localhost';
var ShipSize = 200;
var QueueSize = 10;

var client = influx({ host: DbHost, database: 'prices' });

var CargoShip = async.cargo(function (listings, callback){
  RequestQueue.push(endpoint+'/commerce/prices?ids='+listings.join(','));
  callback();
}, ShipSize);

var RequestQueue = async.queue(function (url, callback){
  request.get(url, function (err, data){
    if(err){
      console.log(err);
      return callback();
    };

    if(!data.body){
      console.log('Missing body!');
      return callback();
    }

    try{
      var prices = JSON.parse(data.body);
      var points = [];
    }catch(e){
      console.log(e);
      return callback();
    };

    async.each(prices, function (price){
      points.push([ {
        buyprice:  price.buys.unit_price,
        buyqty:    price.buys.quantity,
        sellprice: price.sells.unit_price,
        sellqty:   price.sells.quantity,
      }, { item: price.id, name: items[price.id] } ]);
    });

    client.writePoints('price', points, function (err, response){
      if(err){ console.log(err, response); }
      callback();
    });
  });
}, QueueSize);

RequestQueue.drain = function(){
  console.log('All items processed in '+humanizeDuration(new Date() - startTime));
};

var items = {};
function GetItemNames(ids){
  var ItemRequestQueue = async.queue(function (url, callback){
    request.get(url, function (err, data){
      if(err){
        console.log(err);
        return callback();
      };

      if(!data.body){
        console.log('Missing body!');
        return callback();
      };

      try{
        var itemdata = JSON.parse(data.body);
      }catch(e){
        console.log(e);
        return callback();
      };

      async.each(itemdata, function (item){
        items[item.id] = item.name;
      });

      callback();
    });
  }, QueueSize);

  ItemRequestQueue.drain = function(){
    console.log('Finished populating the item database!');
    CrawlListings();
  };

  var ItemShip = async.cargo(function(items, callback){
    ItemRequestQueue.push(endpoint+'/items?ids='+items.join(','));
    callback();
  }, ShipSize);

  async.each(ids, function(id){
    ItemShip.push(id);
  });
};

var startTime;
function CrawlListings(){
  startTime = new Date();
  request.get(endpoint+'/commerce/listings', function (err, data){
    if(err){
      console.log(err);
      return;
    };

    if(!data){
      console.log('No data!');
      return
    };
    
    try{
      var listings = JSON.parse(data.body);
    }catch(e){
      console.log(e);
      return;
    }

    if(Object.keys(items).length === 0){
      console.log('Populating the in memory item name database...');
      GetItemNames(listings);
    }else{
      async.each(listings, function (listing){
        CargoShip.push(listing);
      });
    }
  });
};

CrawlListings();
setInterval(CrawlListings, 1 * 60 * 1000);