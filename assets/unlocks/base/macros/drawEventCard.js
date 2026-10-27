main().then(()=>{console.log("Card Drawn!")})

async function main(){
  let folder = game.folders.find(el=>el.name=="Events");
  if(folder == undefined){
    ui.notifications.error("No Events Folder Yet! Open a pack to find Missions")
    return;
  }

  let cards = folder.content;
  let drawnCard = cards[Math.floor(Math.random() * cards.length)];

  await Tile.create({
    img: drawnCard.img,
    width: 350,
    height: 500,
    x: 4900,
    y: 5050
  })
}