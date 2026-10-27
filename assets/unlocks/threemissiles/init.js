'use strict';
const path = 'systems/risklegacy/assets/unlocks/threemissiles/';

if(game.settings.get('risklegacy', 'base-opened')){
  main().then(()=> {
    ui.notifications.info("Finished Importing Three Missiles Pack!")
  })
} else {
  ui.notifications.error("Please open the Base Pack First");
}


async function main(){
  await importRules();
  await importEvents();
  await importPowers();
  await importScars();
  await importFactions();
  await importSecretMutantPowers();
}

async function importRules(){
  const folderPath = path+'rules/'
  const centerX = canvas.dimensions.width / 4
  const centerY = canvas.dimensions.height / 4

  //Turn Them Into Tiles
  //Import Them Into JournalEntries
  const rulesFile = await(await fetch(folderPath+'cards.yaml')).text()
  const rules = jsyaml.safeLoadAll(rulesFile);
  let zIndex = 10000;

  const folderId = (await Folder.create({ name: 'Nuclear Option Rules', type: "JournalEntry", parent: null })).id;

  for(const rule of rules){
    let _tex = await loadTexture(folderPath+'images/'+rule.imgPath);
    await Tile.create({
      img: folderPath+'images/'+rule.imgPath,
      x: centerX,
      y: centerY,
      z: zIndex,
      width: _tex.width,
      height: _tex.height
    })
    zIndex--;
    await JournalEntry.create({
      name: rule.namespace.split('.')[0],
      img: folderPath+'images/'+rule.imgPath,
      folder: folderId
    }, {renderSheet: false})
  }
}
async function importEvents(){
  const folderPath = path+'events/'
  let eventFolderId = game.folders.find(el=>el.name=="Events")?.id
  if(eventFolderId == undefined){
    eventFolderId = (await Folder.create({ name: 'Events', type: "Item", parent: null })).id;
  }
  const eventsFile = await (await fetch(folderPath+"cards.yaml")).text()
  const events = jsyaml.safeLoadAll(eventsFile);
  for(let event of events){
    for(let i=0; i<event.qty;i++){
      await Item.create({
        name: event.namespace.split(".")[0],
        type: "event",
        folder: eventFolderId,
        permission: {default: 3},
        img: folderPath+`images/${event.imgPath}`
      })
    }
  }
}

async function importPowers() {
  let folderPath = path + 'powers/'
  const powersFile = await (await fetch(folderPath+'cards.yaml')).text()
  const powers = jsyaml.safeLoadAll(powersFile);

  //Create Folder for Starting Powers
  let folderId = (await Folder.create({ name: 'Missile Powers', type: "Item", parent: game.folders.find(el=>el.name=="Powers").id })).id;
  console.log(powers);
  for(let powerObj of powers){
    await Item.create({
      name: powerObj.namespace.split('.')[0],
      type: "power",
      img: folderPath + 'images/missile.png',
      folder: folderId,
      permission: {default: 3},
      data: {
        description: powerObj.data.description,
        type: powerObj.data.type
      }
    })
  }

  //add Bringer of Nuclear Fire as a Red Power
  await Item.create({
    name: "Bringer of Nuclear Fire",
    type: "power",
    img: folderPath + 'images/nuclear.png',
    folder: game.folders.find(el=>el.name=="Powers").id,
    permission: {default: 3},
    data: {
      description: "Bringer of Nuclear Fire: Start with 2 extra Missile Tokens if the Mutant faction is also in play.",
      type: "mission" //not actually mission, we just want it to be red
    }
  })
}

async function importScars() {
  let folderPath = path+'scars/';
  const scarsFile = await (await fetch(folderPath+'cards.yaml')).text()
  const scars = jsyaml.safeLoadAll(scarsFile);

  //Scars
  let folderId = game.folders.find(el=>el.name=="Scars").id;
  for (let scarObj of scars){
    // Create multiple copies of the scar cards
    for(let i=0; i< scarObj.qty; i++){
      await Item.create({
        name: scarObj.namespace.split('.')[0],
        type: "scar",
        folder: folderId,
        permission: {default: 3},
        img: folderPath+`images/${scarObj.data.tokenImg}`,
        data: {
          cardImg: folderPath+"images/"+scarObj.imgPath,
          tokenImg: folderPath+scarObj.data.tokenImg
        }
      })        
    }
  }
}

async function importFactions(){
  const folderPath = path+'factions/'
  const factionsFile = await (await fetch(folderPath+'cards.yaml')).text()
  const factionObj = jsyaml.safeLoad(factionsFile);

  let folderId = (await Folder.create({ name: factionObj.data.name, type: "Actor", parent: null })).id;
  //Create a Faction Card
  let faction = await Actor.create({
    name: factionObj.data.name,
    type: "faction",
    img: folderPath+'images/'+factionObj.imgPath,
    folder: folderId,
    permission: {default: 3},
  })

  //give the mutant faction their starting powers
  faction.createOwnedItem({
    name: "mutant_mission",
    type: "power",
    data: {
      "description": "Controlling all bio-hazard terriotories and the fallout territory earns you 1 Red Star",
      "type": "mission"
    }
  })
  faction.createOwnedItem({
    name: "mutant_knockout_1",
    type: "power",
    data: {
      "description": "When attacking the Bringer of Nuclear Fire's troops, you may re-roll 1's on all attack dice until they are no longer 1's",
      "type": "knockout"
    }
  })
  faction.createOwnedItem({
    name: "mutant_knockout_2",
    type: "power",
    data: {
      "description": "Bio-hazard and mercenary scar effects are reversed for you",
      "type": "knockout"
    }
  })

  faction.createOwnedItem({
    name: "mutant_mission",
    type: "power",
    data: {
      "description": "You don't lose troops in the fallout territory or from Mutant Event Cards",
      "type": "starter"
    }
  })

  faction.createOwnedItem({
    name: "mutant_limitation",
    type: "power",
    data: {
      "description": "Cannot take a missile power",
      "type": "missile"
    }
  })

  faction.createOwnedItem({
    name: "mutant_limitation",
    type: "power",
    data: {
      "description": "Cannot take additional knockout powers",
      "type": "knockout"
    }
  })

  //Create a 1 Troop Sheet
  await Actor.create({
    name: factionObj.namespace.split(".")[0]+"_1",
    type: "troops",
    img: folderPath+'/images/'+factionObj.data.troop_img,
    folder: folderId,
    permission: {default: 3},
  })
  //Create a 3 Troop Sheet
  await Actor.create({
    name: factionObj.namespace.split(".")[0]+"_3",
    type: "troops",
    img: folderPath+'/images/'+factionObj.data.three_img,
    folder: folderId,
    permission: {default: 3},
    token:{
      width: 2,
      height: 2
    }
  })
  //Ceate an HQ Sheet
  await Actor.create({
    name: factionObj.namespace.split(".")[0]+"_hq",
    type: "troops",
    img: folderPath+'/images/'+factionObj.data.hq_img,
    folder: folderId,
    permission: {default: 3},
  })
}

async function importSecretMutantPowers(){
  let folderPath = path + "secretmutantpowers/"
  let file = await (await fetch(folderPath+'cards.yaml')).text()
  let powers = jsyaml.safeLoadAll(file)

  let powersFolderId = game.folders.find(el=>el.name=="Powers").id;
  let mutantPowersID = (await Folder.create({
    name: "DO NOT OPEN UNTIL EVENT!",
    type: "Item",
    parent: powersFolderId
  })).id
  for(let power of powers){
    let powerFolderId = (await Folder.create({
      name: `${power.namespace.split(".")[0]}`,
      type: "Item",
      parent: mutantPowersID
    })).id
    await Item.create({
      name: power.namespace.split(".")[1],
      type: "power",
      img: folderPath+'images/mutant.png',
      data: power.data,
      folder: powerFolderId,
      permission: {default: 3}
    })
  }
}