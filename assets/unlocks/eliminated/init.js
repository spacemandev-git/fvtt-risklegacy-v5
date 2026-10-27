'use strict';
const path = 'systems/risklegacy/assets/unlocks/eliminated/';

if(game.settings.get('risklegacy', 'base-opened')){
  main().then(()=> {
    ui.notifications.info("Finished Importing Eliminated Pack!")
  })
} else {
  ui.notifications.error("Please open the Base Pack First");
}


async function main(){
  await importRules();
  await importPowers();
  await importScars();
}

async function importRules(){
  const folderPath = path+'rules/'
  const centerX = canvas.dimensions.width / 4
  const centerY = canvas.dimensions.height / 4

  //Turn Them Into Tiles
  // First the Biohazard Tile:
  let mercenary_rules_tex = await loadTexture(folderPath+'images/mercenary_rules.jpg')
  await Tile.create({
    img: folderPath+'images/mercenary_rules.jpg',
    x: centerX,
    y: centerY,
    width:mercenary_rules_tex.width,
    height: mercenary_rules_tex.height
  })
  //Import Them Into JournalEntries
  const rulesFile = await(await fetch(folderPath+'cards.yaml')).text()
  const rules = jsyaml.safeLoadAll(rulesFile);
  let zIndex = 10000;

  const folderId = (await Folder.create({ name: 'Knockout Rules', type: "JournalEntry", parent: null })).id;

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
  let folderId = (await Folder.create({ name: 'Knockout Powers', type: "Item", parent: game.folders.find(el=>el.name=="Powers").id })).id;

  for(let powerObj of powers){
    await Item.create({
      name: powerObj.namespace.split('.')[0],
      type: "power",
      img: folderPath + 'images/knockout.png',
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
  let folderId = game.folders.find(el=>el.name == "Scars").id;
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
