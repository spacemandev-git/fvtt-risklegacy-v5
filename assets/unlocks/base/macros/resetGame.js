main().then(()=>{
  ui.notifications.info("Game Reset!")
})

async function main(){
  deleteActorTerritoryCards();
  resetDrawnTerritoryPile();
}

function deleteActorTerritoryCards(){
  const factions = game.actors.filter(el=>el.data.type =="faction")

  for(const faction of factions){
  let newItemsList = [];
  for(const item of faction.items){
    if(item.data.type != "territory"){
      newItemsList.push(item)
    }
  }
  faction.update({"items":newItemsList});
  }
}

function resetDrawnTerritoryPile(){
  let drawnCoinFolder = game.folders.find(el=>el.name=="_drawnCoinCards")
  let coinFolder = game.folders.find(el=>el.name=="Coin Card")
  
  let onboardFolder = game.folders.find(el=>el.name=="_onBoardPile")
  let territoryFolder = game.folders.find(el=>el.name=="Territories")

  for(const card of drawnCoinFolder.content){
    card.update({"folder": coinFolder.id})
  }

  for(const card2 of onboardFolder.content){
    card2.update({"folder": territoryFolder.id})
  }
}