main().then(()=>{console.log("Card Drawn!")})

async function main(){
  let onBoardFolder = game.folders.find(el=>el.name=="_onBoardPile").id
  let cards = game.folders.find(el=>el.name=="Territories").content;
  
  let drawnCard = cards[Math.floor(Math.random() * cards.length)];
  await drawnCard.update({"folder": onBoardFolder})

  await Tile.create({
    img: drawnCard.img,
    width: 350,
    height: 500,
    x: 3550,
    y: 5050
  })
}