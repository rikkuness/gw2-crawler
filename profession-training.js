var async = require('async');
var request = require('request');
var nesting = require('gw2e-recipe-nesting');
var calc = require('gw2e-recipe-calculation');
var util = require('util');
var jsonfile = require('jsonfile');
require('console.table');

// Config
var endpoint = 'https://api.guildwars2.com/v2';

// Cache
var itemCosts = require('./buys_prices');
var items = require('./allItems.json');
itemCosts = calc.useVendorPrices(itemCosts);

// 100-150% bonus... maybe aim low and use 100%

// If critical, grant additional 50% bonus

// Check item rarity
// Masterwork +100% exp
// Rare gives +225% exp

function SimulateLevelling(discipline, startLevel){

  // Create a lookup table of level => XP
  var XPTable = [];
  PopulateXPTable();

  // Load table of all crafting recipes
  var AllRecipes = require('./recipe-tree.json');

  // Load additional metadata for items
  var meta = require('./type-map.json');

  // Set where we start levelling from and take a stab at the current XP
  var level = startLevel;
  var RunningCXP = 0;
  for(var l=0;l<=level;l++){
    RunningCXP += XPTable[l];
  }

  var last;
  var MyItems = {};
  var discovered = [];
  var total = { xp:0, cost:0, bought:{}, craft:{}, qty:0 };

  // The process will exit for trades that stop at 400 ideally should change this.
  while(level<=500){
    DetermineBestStep();
  }

  // XP lookup table as per https://wiki.guildwars2.com/wiki/Crafting#Crafting_experience
  function PopulateXPTable(){
    for(var i=0;i<=500;i++){
      if(i===0){
        XPTable.push(0);
        continue;
      }
      if(i===1){
        XPTable.push(500);
        continue;
      }
      if(i<400){
        XPTable.push(Math.floor(XPTable[i-1] * 1.01))
      }else{
        XPTable.push(24028);
      }
    }
  }

  // Return level, discipline and XP amount
  function GetDisciplineStatus(callback){

    // Determine the current level based on the amount of XP
    var x = RunningCXP;
    for(var i=0;i<=500;i++){
      if(x>XPTable[i]){
        x -= XPTable[i];
      }else{
        level = i;
        break;
      }
    }

    if(level === 75) console.log('Became Initiate '+discipline+'!');
    if(level === 150) console.log('Became Apprentice '+discipline+'!');
    if(level === 225) console.log('Became Journeyman '+discipline+'!');
    if(level === 300) console.log('Became Adept '+discipline+'!');
    if(level === 400) {
      console.log('Became Master '+discipline+'!');
      if(/^(Jeweler|Chef|Scribe)$/.test(discipline)) return callback(true, 'Finished!')
    }
    if(level === 500) {
      console.log('Became Grandmaster '+discipline+'!');
      return callback(true, 'Finished!');
    }

    callback(null, {
      level: level,
      discipline: discipline,
      RunningCXP: RunningCXP
    });
  }

  // Find recipes valid for the given discipline and level
  function GetRecipes(status, callback){
    async.filter(AllRecipes, function(recipe, callback){
      callback(null, recipe.disciplines.includes(status.discipline) && recipe.min_rating <= status.level)
    }, function(err, recipes){
      callback(err, status, recipes);
    });
  }

  // Use cheapestTree to calculate all costs
  function GetPrices(status, recipes, callback){
    async.map(recipes, function(recipe, callback){
      var tree = calc.cheapestTree(1, recipe, itemCosts, MyItems);
      callback(null, tree);
    }, function(err, tree){
      callback(err, status, tree);
    });
  }

  // Try to determine the amount of XP granted for crafting a particular recipe.
  function CalculateCXP(r, lvl){
    var multiplier = 1.4;
    var span = 40;
    if(r.type === 'Refinement'){
      multiplier = 0.3;
      span = 25;
    }else if(r.type === 'Component' || r.type === 'UpgradeComponent'){
      multiplier = 0.6;
      span = 25;
    }else if(r.type){
      console.log(r.type);
    }

    var xp_gain = XPTable[(lvl+1)]*multiplier*(1.0-(lvl-r.min_rating)/span);
    if(xp_gain < 0){ xp_gain = 0; };

    if(!r.discovered) xp_gain *= 2;
    xp_gain = Math.floor(xp_gain);

    return xp_gain;
  }

  // Add additional metadata to the cheapestTree result.
  function AddMetaToComponents(status, components, callback){
    async.map(components, function(a, callback){

      // Lookup the item name and add to result
      a.name = items[a.id];

      // This is a crafting component, try to determine the XP gain at the 
      // current level.
      if(a.hasOwnProperty('disciplines')){
        a.cxp = CalculateCXP(a, status.level) || 0;

        // Add a float value that's a rough esitmation of cost per XP
        if(a.cxp > 0 && a.craftPrice > 0) a.deriv = a.craftPrice / a.cxp;
      }

      // Append the metadata
      if(meta[a.id]){
        a.type = meta[a.id].type;
        a.time_to_craft_ms = meta[a.id].time_to_craft_ms;
        a.flags = meta[a.id].flags;
        a.discovered = a.flags.includes('AutoLearned') || discovered.includes(a.id);
      }

      // If there are subcomponents, add metadata to those too
      if(a.hasOwnProperty('components')){
        AddMetaToComponents(status, a.components, function(err, components){
          a.components = components;
          callback(null, a);
        })
      }else{
        callback(null, a);
      }
    }, callback);
  }

  // Use the price per exp added earlier to decide which item is the best value.
  function PickTheBest(recipes, callback){
    async.reduce(recipes, {deriv:9999999999}, function(last, r, callback){
      if(r.deriv<last.deriv&&r.deriv>0) last = r;
      callback(null, last)
    }, callback)
  }

  // Perform all tasks sequencially to decide what we should do next.
  function DetermineBestStep(){
    async.waterfall([
      async.apply(GetDisciplineStatus),
      async.apply(GetRecipes),
      async.apply(GetPrices),
      async.apply(AddMetaToComponents),
      async.apply(PickTheBest),
    ], function(err, winner){
      if(err) process.exit(0);
      CraftItem(winner);
    })
  }

  // Go through the motions as if we were crafting this in game. Perfoms full
  // inventory management.
  function CraftItem(recipe){

    function SubCrafting(r, callback){

      // First take care of the subcomponents
      if(r.hasOwnProperty('components')) async.each(r.components, SubCrafting)
      

      // Items obtained but not bought
      if(!r.buyPrice&&!r.hasOwnProperty('components')){
        if(!MyItems.hasOwnProperty(r.id)) MyItems[r.id] = 0;
        MyItems[r.id] += r.quantity;
      }

      // Items bought
      if(r.buyPrice&&!r.craft){

        // Add bought to invent
        if(!MyItems.hasOwnProperty(r.id)) MyItems[r.id] = 0;
        MyItems[r.id] += r.quantity;

        // Add to shopping list
        if(!total.bought.hasOwnProperty(r.id)) total.bought[r.id] = 0;
        total.bought[r.id] += r.quantity;

        // Add to cost
        total.cost += r.buyPrice;
      }


      if(r.craft&&r.hasOwnProperty('components')){

        // Remove component costs from invent
        async.each(r.components, function(r, callback){
          MyItems[r.id] -= r.quantity;
          callback();
        })

        // Add the resulting crafted item to the inventory
        if(!MyItems.hasOwnProperty(r.id)) MyItems[r.id] = 0;
        MyItems[r.id] += r.quantity;

        if(!total.craft.hasOwnProperty(r.id)) total.craft[r.id] = 0;
        total.craft[r.id] += r.quantity;
      }

      if(r.cxp) total.xp += r.cxp;

      callback();
    }

    SubCrafting(recipe, function(err, msg){
      total.craft[recipe.id] += 1;

      // Add item to inventory
      if(!MyItems.hasOwnProperty(recipe.id)) MyItems[recipe.id] = 0;
      MyItems[recipe.id] += 1;

      total.qty += 1;

    });

    if(!last) last = recipe;

    if(last && recipe.id != last.id){
      console.log('---===== '+total.qty+'x '+last.name+' =====---');
      console.log(' Price: '+total.cost+'\n XP: +'+total.xp+'XP');
      console.log(' Buy:');
      for(var id in total.bought){
        console.log('   '+total.bought[id]+'x "'+items[id]+'"');
      }

      console.log(' Craft:');
      for(var id in total.craft){
        console.log('   '+total.craft[id]+'x "'+items[id]+'"');
      }

      console.log('   '+total.qty+'x "'+items[last.id]+'"\n');

      // reset totals
      total = { xp:0, cost:0, bought:{}, craft:{}, qty:0 };
      last = recipe;

     /*for(var id in MyItems){
      if(MyItems[id]>0) console.log(MyItems[id]+'x '+items[id]);
     } */
    }

    RunningCXP += recipe.cxp;
  }
}

SimulateLevelling('Jeweler', 0);


// Get all recipes from the Guild Wars 2 API and store the data to files for
// faster access later on.
function BuildRecipeTree(){
  var AllRecipes = [];
  var MetaTable = {};

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

      async.each(itemdata, function (recipe){
        AllRecipes.push(recipe);
        MetaTable[recipe.output_item_id] = {
          type: recipe.type,
          time_to_craft_ms: recipe.time_to_craft_ms,
          flags: recipe.flags
        };
      });

      callback();
    });
  }, 10);

  ItemRequestQueue.drain = function(){
    var tree = nesting(AllRecipes);
    jsonfile.writeFile('./recipe-tree.json', tree);
    jsonfile.writeFile('./type-map.json', MetaTable);
    console.log('Finished populating the recipe tree!');
  };

  var ItemShip = async.cargo(function(items, callback){
    ItemRequestQueue.push(endpoint+'/recipes?ids='+items.join(','));
    callback();
  }, 200);

  request.get(endpoint+'/recipes', function(err, data){
    var bleh = JSON.parse(data.body);
    async.each(bleh, function(id){
      ItemShip.push(id);
    });
  });
};
