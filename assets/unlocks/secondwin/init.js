'use strict';
const path = 'systems/risklegacy/assets/unlocks/secondwin/';

if(game.settings.get('risklegacy', 'base-opened')){
  main().then(()=> {
    ui.notifications.info("Finished Importing Second Win Pack!")
  })
} else {
  ui.notifications.error("Please open the Base Pack First");
}

async function main(){
  await importRules();
  await importEvents();
  await importMissions();
  await importStickerSheet();
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

  const folderId = (await Folder.create({ name: 'Homeland Rules', type: "JournalEntry", parent: null })).id;

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

async function importStickerSheet(){
  let folderPath = path + 'stickersheet/';
  let stickerSheetFolder = game.folders.find(el=>el.name=="Sticker Sheet").id
  let worldCapitalFolder = (await Folder.create({ name: 'World Capital', type: "Item", parent: stickerSheetFolder })).id;

  let stickersFile = await (await fetch(folderPath+'cards.yaml')).text()
  let stickers = jsyaml.safeLoadAll(stickersFile);

  for(const sticker of stickers){
    await Item.create({
      name: sticker.namespace.split(".")[0],
      type: "scar",
      folder: worldCapitalFolder,
      permission: {default: 3},
      img: folderPath+`images/${sticker.imgPath}`
    })
  }
}

async function importMissions(){
  const folderPath = path + 'missions/';
  const file = await (await fetch(folderPath+'cards.yaml')).text()
  const missions = jsyaml.safeLoadAll(file);

  //create a missions folder if one doesn't exist
  let folder = game.folders.find(el=>el.name=="Missions")?.id
  if(folder==undefined){
    folder = await Folder.create({name:"Missions", type:"Item", parent: null })
  }

  for(const mission of missions){
    await Item.create({
      name: mission.namespace.split(".")[0],
      type:"mission",
      folder: folder,
      permission: {default: 3},
      img: folderPath+'images/'+mission.imgPath
    })
  }

}