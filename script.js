const messages=document.getElementById("messages");
const typing=document.getElementById("typing");


const conversation=[

["left","Alex","Hey, have you seen Current yet?"],

["right"," ","Yeah, the customization is actually nice."],

["left"," ","The privacy model is what got me."],

["right"," ","Open source messaging feels different."]

];



function wait(ms){

return new Promise(r=>setTimeout(r,ms));

}



async function sendMessage(type,name,text){


typing.style.display="block";

await wait(800);


typing.style.display="none";


let div=document.createElement("div");

div.className="message "+type;

div.textContent=name+": ";

messages.appendChild(div);



for(const char of text){

div.textContent+=char;

await wait(30+Math.random()*80);

}


}



async function runChat(){

for(const msg of conversation){

await sendMessage(
msg[0],
msg[1],
msg[2]
);

await wait(600);

}

}


runChat();




document.querySelectorAll(".ripple-btn")
.forEach(btn=>{

btn.onclick=e=>{

let r=document.createElement("span");

r.className="ripple";

let size=Math.max(
btn.offsetWidth,
btn.offsetHeight
);


r.style.width=size+"px";

r.style.height=size+"px";

r.style.left=e.offsetX-size/2+"px";

r.style.top=e.offsetY-size/2+"px";


btn.appendChild(r);


setTimeout(()=>r.remove(),700);

};


});



document.getElementById("theme")
.onclick=()=>{

document.body.classList.toggle("dark");

};
