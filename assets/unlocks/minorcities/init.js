'use strict';
const path = 'systems/risklegacy/assets/unlocks/minorcities/';

if(game.settings.get('risklegacy', 'base-opened')){
  main().then(()=> {
    ui.notifications.info("Finished Importing Minor Cities Pack!")
  })
} else {
  ui.notifications.error("Please open the Base Pack First");
}


async function main(){
  await importRules(); //DONE
  await importScars();
  await importEvents();
  await importDraftCards();
  await importMacros();
}

async function importRules(){
  const folderPath = path+'rules/'
  const centerX = canvas.dimensions.width / 4
  const centerY = canvas.dimensions.height / 4

  //Turn Them Into Tiles
  // First the Biohazard Tile:
  let biohazard_rules_tex = await loadTexture(folderPath+'images/biohazard_rules.jpg')
  await Tile.create({
    img: folderPath+'images/biohazard_rules.jpg',
    x: centerX,
    y: centerY,
    width:biohazard_rules_tex.width,
    height: biohazard_rules_tex.height
  })
  //Import Them Into JournalEntries
  const rulesFile = await(await fetch(folderPath+'cards.yaml')).text()
  const rules = jsyaml.safeLoadAll(rulesFile);
  let zIndex = 10000;

  const folderId = (await Folder.create({ name: 'Draft Rules', type: "JournalEntry", parent: null })).id;

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

async function importScars() {
  let folderPath = path+'scars/';
  const scarsFile = await (await fetch(folderPath+'cards.yaml')).text()
  const scars = jsyaml.safeLoadAll(scarsFile);

  //Scars
  let folderId = game.folders.find(el=>el.name == "Scars").id

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

async function importDraftCards(){
  const folderPath = path+'draft/';

  const draftFolder = (await Folder.create({ name: 'Draft', type: "Item", parent: null })).id;
  const coinsFolder = (await Folder.create({ name: 'Coins', type: "Item", parent: draftFolder })).id;
  const placementFolder = (await Folder.create({ name: 'Placement', type: "Item", parent: draftFolder })).id;
  const troopsFolder = (await Folder.create({ name: 'Troops', type: "Item", parent: draftFolder })).id;
  const turnFolder = (await Folder.create({ name: 'Turn', type: "Item", parent: draftFolder })).id;
  const cardsFile = await(await fetch(folderPath+'cards.yaml')).text()
  
  const cards = jsyaml.safeLoadAll(cardsFile);
  for(const card of cards){
    let folderId = ""
    if(card.data.type == "coin"){folderId=coinsFolder}
    else if(card.data.type == "placement"){folderId=placementFolder}
    else if(card.data.type == "troops"){folderId=troopsFolder}
    else if(card.data.type == "turn"){folderId=turnFolder}

    await Item.create({
      name: card.namespace.split(".")[0],
      img: folderPath+'images/'+card.imgPath,
      folder: folderId,
      permission: {default: 3},
      type: "draft",
      data: card.data
    })
  }

}

async function importMacros(){
  const folderPath = path+'macros/';
  const draftSetup = await (await fetch(folderPath+'draftSetup.js')).text();
  await Macro.create({
    name: "Draft Setup",
    type: "script",
    permission: {default:3},
    img: folderPath+'images/draft.png',
    command: draftSetup
  }, {displaySheet: false});
}