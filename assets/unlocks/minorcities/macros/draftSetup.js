new Dialog({
  title: "Pick Players",
  content: `
  <div style="display:flex">
    <h1 style="flex:2"> How many players? </h1>
    <select style="flex:1" id="playerNum">
      <option value=3>3</option>
      <option value=4>4</option>
      <option value=5>5</option>
    </select>
  </div>
  `,
  buttons: {
    "ok": {
      label: "Draft Setup",
      callback: async (html) => {
        await placeCards(html.find("#playerNum")[0].value)
      }
    },
    "cancel": {
      label: "Cancel"
    }
  }
}).render(true);

async function placeCards(playerNum){
  //console.log(playerNum);

  const draftFolder = game.folders.find(el=>el.name=="Draft") 
  const coinFolder = draftFolder.children.find(el=>el.name=="Coins")
  const placementFolder = draftFolder.children.find(el=>el.name=="Placement")
  const troopsFolder = draftFolder.children.find(el=>el.name=="Troops")
  const turnFolder = draftFolder.children.find(el=>el.name=="Turn")

  let _x = canvas.dimensions.width/4;
  let _y = canvas.dimensions.width/4;
  let cardWidth = 500
  let cardHeight = 350

  for(const coin of coinFolder.content){
    if(coin.data.data.players <= playerNum){
      await Tile.create({
        img: coin.img,
        x: _x,
        y: _y,
        z: coin.data.data.z,
        height: cardHeight,
        width: cardWidth,
      })
    }
  }

  for(const placement of placementFolder.content){
    if(placement.data.data.players <= playerNum){
      await Tile.create({
        img: placement.img,
        x: _x + ((cardWidth + 20 ) * 1 ),
        y: _y,
        z: placement.data.data.z,
        height: cardHeight,
        width: cardWidth,
      })
    }
  }

  for(const troops of troopsFolder.content){
    if(troops.data.data.players <= playerNum){
      await Tile.create({
        img: troops.img,
        x: _x + ((cardWidth + 20 ) * 3 ),
        y: _y,
        z: troops.data.data.z,
        height: cardHeight,
        width: cardWidth,
      })
    }
  }

  for(const turn of turnFolder.content){
    if(turn.data.data.players <= playerNum){
      await Tile.create({
        img: turn.img,
        x: _x + ((cardWidth + 20 ) * 2 ),
        y: _y,
        z: turn.data.data.z,
        height: cardHeight,
        width: cardWidth,
      })
    }
  }
}