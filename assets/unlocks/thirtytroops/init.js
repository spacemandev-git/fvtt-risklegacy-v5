'use strict';
const path = 'systems/risklegacy/assets/unlocks/thirtytroops/';

if(game.settings.get('risklegacy', 'base-opened')){
  main().then(()=> {
    ui.notifications.info("Finished Importing Thirty Troops Pack!")
  })
} else {
  ui.notifications.error("Please open the Base Pack First");
}

async function main(){
  await importRules()
  await importEvents()
  await importPowers()
  await importScars()
  await importFaction()
  await importStickerSheet()
  await importTerritories()
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

  const folderId = (await Folder.create({ name: 'Alien Rules', type: "JournalEntry", parent: null })).id;

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
  let folderId = (await Folder.create({ name: 'Weaknesses', type: "Item", parent: game.folders.find(el=>el.name=="Powers").id })).id;
  for(let powerObj of powers){
    await Item.create({
      name: powerObj.namespace.split('.')[0],
      type: "power",
      img: folderPath + 'images/weakness.png',
      folder: folderId,
      permission: {default: 3},
      data: powerObj.data
    })
  }
}

async function importScars() {
  let folderPath = path+'scars/';
  const scarsFile = await (await fetch(folderPath+'cards.yaml')).text()
  const scars = jsyaml.safeLoadAll(scarsFile);

  //Scars
  let folderId = game.folders.find(el=>el.name == "Scars").id

  for (let scarObj of scars){
    // Create multiple copies of the scar cards
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

async function importFaction(){
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
    name: "alien_mission",
    type: "power",
    data: {
      "description": "Controlling every city on the board earns you 2 Red Stars",
      "type": "mission"
    }
  })
  faction.createOwnedItem({
    name: "alien_knockout",
    type: "power",
    data: {
      "description": "When recruiting, you get 2 extra troops if you control Alien Island and 1 extra troop for every Ruin you control.",
      "type": "knockout"
    }
  })
  faction.createOwnedItem({
    name: "alien_starter",
    type: "power",
    data: {
      "description": "You do not lose troops expanding into enemy cities",
      "type": "starter"
    }
  })

  faction.createOwnedItem({
    name: "alien_limitations",
    type: "power",
    data: {
      "description": "You cannot be given a weakness.",
      "type": "weakness"
    }
  })

  faction.createOwnedItem({
    name: "alien_limitations",
    type: "power",
    data: {
      "description": "You cannot be given a missile power.",
      "type": "missile"
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

async function importStickerSheet(){
  let folderPath = path + 'stickersheet/';
  let stickerSheetFolder = game.folders.find(el=>el.name=="Sticker Sheet").id
  let folder = (await Folder.create({ name: 'Ruins', type: "Item", parent: stickerSheetFolder })).id;

  let stickersFile = await (await fetch(folderPath+'cards.yaml')).text()
  let sticker = jsyaml.safeLoad(stickersFile);

  await Item.create({
    name: sticker.namespace.split(".")[0],
    type: "scar",
    folder: folder,
    permission: {default: 3},
    img: folderPath+`images/${sticker.imgPath}`
  })

}

async function importTerritories() {
  const folderPath = path+'territories/'
  const territoriesFile = await (await fetch(folderPath+'cards.yaml')).text()
  const territories = jsyaml.safeLoadAll(territoriesFile);
  const folderId = game.folders.find(el=>el.name=="Territories").id;

  for(const t of territories){
    await Item.create({
      name: t.namespace.split(".")[0],
      type: "territory",
      folder: folderId,
      permission: {default: 3},
      img: folderPath+`images/cards.${t.data.value}/${t.imgPath}`,
      data: {
        coinImg: folderPath+'images/coin.png',
        value: t.data.value,
        contient: t.data.continent
      }
    })
  }  
}