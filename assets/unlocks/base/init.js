'use strict';
const path = 'systems/risklegacy/assets/unlocks/base/'
main().then(() => {
  ui.notifications.info("Finished Importing Base Game!")
  console.log("RISK LEGACY | Finished importing base game!")
});

async function main(){
  // Import Powers As Items
  await importPowers();
  await importScars();
  await importTerritories();
  await importCoinCards();
  await importFactions();
  await importStickerSheet();
  await importMacros();
}

async function importPowers() {
  let folderPath = path + 'powers/'
  const powersFile = await (await fetch(folderPath+'cards.yaml')).text()
  const powers = jsyaml.safeLoadAll(powersFile);

  //Create Folder for Starting Powers
  const powersFolder = (await Folder.create({ name: 'Powers', type: "Item", parent: null })).id;
  let folderId = (await Folder.create({ name: 'Starting Powers', type: "Item", parent: powersFolder })).id;


  for(let powerObj of powers){
    await Item.create({
      name: powerObj.namespace.split('.')[0],
      type: "power",
      img: 'systems/risklegacy/assets/unlocks/base/powers/starter.png',
      folder: folderId,
      permission: {default: 3},
      data: {
        description: powerObj.data.description,
        type: powerObj.data.type
      }
    })
  }
}

async function importScars() {
  let folderPath = path+'scars/';
  const scarsFile = await (await fetch(folderPath+'cards.yaml')).text()
  const scars = jsyaml.safeLoadAll(scarsFile);

  //Scars
  let folderId = (await Folder.create({ name: 'Scars', type: "Item", parent: null })).id;
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

async function importTerritories() {
  const folderPath = path+'territories/'
  const territoriesFile = await (await fetch(folderPath+'cards.yaml')).text()
  const territories = jsyaml.safeLoadAll(territoriesFile);
  const folderId = (await Folder.create({name: "Territories", type:"Item", parent: null})).id;
  //also create a drawn/discard pile where the cards are moved when drawn
  await Folder.create({name: "_onBoardPile", type: "Item", parent: folderId})
  const variant = game.settings.get('risklegacy', 'variant');

  for(const t of territories){
    await Item.create({
      name: t.namespace.split(".")[0],
      type: "territory",
      folder: folderId,
      permission: {default: 3},
      img: folderPath+`images/${variant}/cards.${t.data.value}/${t.imgPath}`,
      data: {
        coinImg: folderPath+'images/coin.png',
        value: t.data.value,
        contient: t.data.continent
      }
    })
  }  
}

async function importCoinCards(){
  const folderId = (await Folder.create({name: "Coin Card", type:"Item", parent: null})).id;
  await Folder.create({name: "_drawnCoinCards", type: "Item", parent: folderId})
  for(let i=0; i<10; i++){
    await Item.create({
      name: "coin_card",
      type: "coin",
      folder: folderId,
      permission: {default: 3},
      img: 'systems/risklegacy/assets/unlocks/base/territories/images/coin_card.jpg'
    })
  }
}

async function importFactions(){
  const folderPath = path+'factions/'
  const factionsFile = await (await fetch(folderPath+'cards.yaml')).text()
  const factions = jsyaml.safeLoadAll(factionsFile);



  for(let faction of factions){
    //Create a Folder
    let folderId = (await Folder.create({ name: faction.data.name, type: "Actor", parent: null })).id;
    //Create a Faction Card
    await Actor.create({
      name: faction.data.name,
      type: "faction",
      img: folderPath+'images/'+faction.imgPath,
      folder: folderId,
      permission: {default: 3},
    })
    //Create a 1 Troop Sheet
    await Actor.create({
      name: faction.namespace.split(".")[0]+"_1",
      type: "troops",
      img: folderPath+'/images/'+faction.data.troop_img,
      folder: folderId,
      permission: {default: 3},
    })
    //Create a 3 Troop Sheet
    await Actor.create({
      name: faction.namespace.split(".")[0]+"_3",
      type: "troops",
      img: folderPath+'/images/'+faction.data.three_img,
      folder: folderId,
      permission: {default: 3},
      token:{
        width: 2,
        height: 2
      }
    })
    //Ceate an HQ Sheet
    await Actor.create({
      name: faction.namespace.split(".")[0]+"_hq",
      type: "troops",
      img: folderPath+'/images/'+faction.data.hq_img,
      folder: folderId,
      permission: {default: 3},
      token: {
        width: 3,
        height: 3
      }
    })
  }
}

async function importStickerSheet(){
  let folderPath = path+'stickersheet/'
  //Parent Folder
  let stickerSheetFolder = (await Folder.create({ name: 'Sticker Sheet', type: "Item", parent: null })).id;
  let stickersFile = await (await fetch(folderPath+'cards.yaml')).text()
  let stickers = jsyaml.safeLoadAll(stickersFile);

  let beforeFirstGameFolder = (await Folder.create({ name: 'Before First Game', type: "Item", parent: stickerSheetFolder })).id;
  let helOnFolder = (await Folder.create({ name: 'Held On', type: "Item", parent: stickerSheetFolder })).id;
  let wonFolder = (await Folder.create({ name: 'Game Won', type: "Item", parent: stickerSheetFolder })).id;
  
  for(let sticker of stickers){
    for(let q=0; q<sticker.qty;q++){
      let stickerFolder = ""
      if(sticker.data.folder == "Before First Game"){
        stickerFolder = beforeFirstGameFolder
      } else if (sticker.data.folder == "Held On"){
        stickerFolder = helOnFolder
      } else if(sticker.data.folder == "Game Won"){
        stickerFolder = wonFolder
      }
      
      await Item.create({
        name: sticker.namespace.split(".")[0],
        type: "scar",
        folder: stickerFolder,
        permission: {default: 3},
        img: folderPath+`images/${sticker.imgPath}`,
        data: {
          cardImg: folderPath+`images/${sticker.imgPath}`,
          tokenImg: folderPath+`images/${sticker.imgPath}`
        }
      })
    }
  }
}

async function importMacros(){
  let folderPath = path+'macros/'

  //Draw Territory Card Macro
  const tCardDrawText = await (await fetch(folderPath+'drawTerritoryCard.js')).text()
  await Macro.create({
    name: "Draw Territory Card",
    type: "script",
    img: folderPath+'images/continent.png',
    command: tCardDrawText
  }, {displaySheet:false})
  //Reset Game Macro
  const resetGameMacro = await (await fetch(folderPath+'resetGame.js')).text()
  await Macro.create({
    name: "Reset Game",
    type: "script",
    img: folderPath+'images/reset.png',
    command: resetGameMacro
  }, {displaySheet:false})
  //Increase Card Value Macro
  const increaseCardValue = await (await fetch(folderPath+'updateCardValue.js')).text()
  await Macro.create({
    name: "Increase Card Value",
    type: "script",
    permission: {default:3},
    img: folderPath+'images/plus.png',
    command: increaseCardValue
  }, {displaySheet:false})
  //Deal Scars Macro
  const drawScars = await (await fetch(folderPath+'drawScars.js')).text()
  await Macro.create({
    name: "Randomly Deal Scars",
    type: "script",
    permission: {default:3},
    img: folderPath+'images/scar.png',
    command: drawScars
  }, {displaySheet:false})
  //Draw Mission Card Macro
  const missionCards = await (await fetch(folderPath+'drawMissionCard.js')).text()
  await Macro.create({
    name: "Draw Mission Card",
    type: "script",
    permission: {default:3},
    img: folderPath+'images/mission.png',
    command: missionCards
  }, {displaySheet:false})
  //Draw Event Cards Macro
  const drawEvent = await (await fetch(folderPath+'drawEventCard.js')).text()
  await Macro.create({
    name: "Draw Event Card",
    type: "script",
    permission: {default:3},
    img: folderPath+'images/event.png',
    command: drawEvent
  }, {displaySheet:false})

  //Setup Coin Cards In the Beginning
  const setupCoin = await (await fetch(folderPath+'setupCoinCards.js')).text()
  await Macro.create({
    name: "Place Coin Cards",
    type: "script",
    permission: {default:3},
    img: folderPath+'images/coin.png',
    command: setupCoin
  }, {displaySheet:false})
}