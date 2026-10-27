const territoryCardList = game.folders.find(el=> el.name=="Territories").content.map(el=>{return el.name});
console.log(territoryCardList)
let territoryOptions = ""
for(let t of territoryCardList){
  territoryOptions += `<option value="${t}">${t}</option>`
}

const template = `
  <div class="form-group">
    <select id="selectedTerritory">${territoryOptions}</select>
  </div>
`
new Dialog({
  title: "Increase Card Value",
  content: template,
  buttons:{
    ok: {
      label: "Increase By 1",
      callback: (html)=>{increaseValue(html)}
    },
    cancel: {
      label: "Cancel"
    }
  }
}).render(true);

function increaseValue(html){
  let territoryName = html.find("#selectedTerritory")[0].value;
  let territory = game.items.find(el=>el.name == territoryName);
  if(territory.data.data.value == 6){
    ui.notifications.error("Territory cannot be increased passed 6!")
  } else {
    let newVal = territory.data.data.value+1
    territory.update({"data.value":newVal});
    let newPath = territory.img.replace(/cards.\d/, `cards.${newVal}`) //works regardless of what pack its from
    territory.update({"img": newPath})
  }
} 