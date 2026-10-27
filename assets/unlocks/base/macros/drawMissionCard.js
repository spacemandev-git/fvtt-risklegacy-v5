main().then(()=>{console.log("Card Drawn!")})

async function main(){
  let missionsFolder = game.folders.find(el=>el.name=="Missions");
  if(missionsFolder == undefined){
    ui.notifications.error("No Missions Folder Yet! Open a pack to find Missions")
    return;
  }

  let cards = missionsFolder.content;
  let drawnCard = cards[Math.floor(Math.random() * cards.length)];

  await Tile.create({
    img: drawnCard.img,
    x: 4350,
    y: 5150,
    width: 500,
    height: 350
  })
}