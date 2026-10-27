main().then(()=>{})

async function main(){
  const folder = game.folders.find(el=>el.name=="Coin Card");
  for(let coin of folder.content){
    await Tile.create({
      img: 'systems/risklegacy/assets/unlocks/base/territories/images/coin_card.jpg',
      width: 350,
      height: 500,
      x: 3950,
      y: 5050
    })
  }
}