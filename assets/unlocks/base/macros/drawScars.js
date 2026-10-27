//Dialog Box to Ask Which Factions Should Draw A Card
//If more selected than are cards, then show error
const factions = game.actors.filter(el=>el.data.type=="faction")
main().then(()=>{
  console.log("Finished Dealing Scars!")
})

async function main(){
  let factionRows = ""
  for(let faction of factions){
    console.log(faction.name);
    factionRows += `
    <div style="display:flex">
      <span style="flex:3">${faction.name}</span><input style="flex:1" type="checkbox" id="${faction.id}"/>
    </div>
    `
  }
  
  
  let template = `
    <div style="display:flex; flex-direction:column>
      ${factionRows}
    </div>
  `
  
  new Dialog({
    title: "Deal Scars",
    content: template,
    buttons:{
      ok: {
        label: "Deal Scars",
        callback: dealScars
      }, 
      cancel: {
        label: "Cancel"
      }
    }
  }).render(true);
}

async function dealScars(html){
  let scars = game.folders.find(el=>el.name=="Scars").content

  let factionsSelected = []

  for(const faction of factions){
    if(html.find(`#${faction.id}`)[0].checked){
      factionsSelected.push(faction)
    }
  }

  if(factionsSelected.length > scars.length){
    ui.notifications.error("Not enough scars for everyone, so no one gets one!")
  } else {
    //console.log("Dealing Scars");
    let shuffledScars = shuffle(scars)  
    for(let i=0; i<factionsSelected.length; i++){
      factionsSelected[i].createOwnedItem(shuffledScars[i])
    }
  }
}

function shuffle(array) {

	var currentIndex = array.length;
	var temporaryValue, randomIndex;

	// While there remain elements to shuffle...
	while (0 !== currentIndex) {
		// Pick a remaining element...
		randomIndex = Math.floor(Math.random() * currentIndex);
		currentIndex -= 1;

		// And swap it with the current element.
		temporaryValue = array[currentIndex];
		array[currentIndex] = array[randomIndex];
		array[randomIndex] = temporaryValue;
	}

	return array;
};