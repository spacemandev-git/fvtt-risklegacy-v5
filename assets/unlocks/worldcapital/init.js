'use strict';
const path = 'systems/risklegacy/assets/unlocks/worldcapital/';

if(game.settings.get('risklegacy', 'base-opened')){
  main().then(()=> {
    ui.notifications.info("Finished Importing World Capital Pack!")
  })
} else {
  ui.notifications.error("Please open the Base Pack First");
}


async function main(){
  await importRules();
  await importMissions();
  await importPowers();
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

  const folderId = (await Folder.create({ name: 'World Capital Rules', type: "JournalEntry", parent: null })).id;

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
async function importPowers() {
  let folderPath = path + 'powers/'
  const powersFile = await (await fetch(folderPath+'cards.yaml')).text()
  const powers = jsyaml.safeLoadAll(powersFile);

  //Create Folder for Starting Powers
  let folderId = (await Folder.create({ name: 'Mission Powers', type: "Item", parent: game.folders.find(el=>el.name=="Powers").id })).id;

  for(let powerObj of powers){
    await Item.create({
      name: powerObj.namespace.split('.')[0],
      type: "power",
      img: folderPath + 'images/mission.png',
      folder: folderId,
      permission: {default: 3},
      data: {
        description: powerObj.data.description,
        type: powerObj.data.type
      }
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