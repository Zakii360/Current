import { supabase } from "./supabase.js";



const messages =
document.getElementById("messages");


const input =
document.getElementById("messageInput");


const send =
document.getElementById("send");





async function getUser(){


const {

data:{
session

}

}=await supabase.auth.getSession();



if(!session){

location.href="landing.html";

return;

}


}



getUser();





function addMessage(text,type="right"){


const div=document.createElement("div");


div.className=
"message "+type;


div.textContent=text;


messages.appendChild(div);


messages.scrollTop=
messages.scrollHeight;


}





send.onclick=async()=>{


const text=input.value.trim();


if(!text)return;



addMessage(text);



input.value="";



/*

Future:

await supabase
.from("current_messages")
.insert({

conversation_id:"",
sender_id:"",
ciphertext:text

})

*/


};





input.addEventListener(
"keydown",
e=>{

if(e.key==="Enter"){

send.click();

}

});






// Realtime preparation


/*

supabase
.channel("current_messages")
.on(
"postgres_changes",
{
event:"INSERT",
schema:"public",
table:"current_messages"
},
payload=>{

console.log(payload);

}
)
.subscribe();


*/
