import {supabase} from "./supabase.js";


const messages =
document.getElementById("messages");


const input =
document.getElementById("messageInput");


const send =
document.getElementById("send");


let conversationId = null;



async function start(){


const {
data:{
session
}

}=await supabase.auth.getSession();


if(!session){

location.href="auth.html";

return;

}



await loadMessages();



subscribe();


}



async function loadMessages(){


/*

Temporary:
replace with selected conversation

*/


const {
data

}=await supabase
.from("current_messages")
.select("*")
.order(
"created_at",
{
ascending:true
}
);



messages.innerHTML="";



data?.forEach(message=>{


addMessage(
message.ciphertext,
message.sender_id===
session.user.id
?
"right":
"left"
);


});


}





function addMessage(text,type){


const div=
document.createElement("div");


div.className=
"message "+type;


div.textContent=text;


messages.appendChild(div);


}





send.onclick=async()=>{


const text=
input.value.trim();


if(!text)return;



const {
data:{
session
}

}=await supabase.auth.getSession();



await supabase
.from("current_messages")
.insert({

conversation_id:
conversationId,

sender_id:
session.user.id,

ciphertext:
text

});



input.value="";


};






function subscribe(){


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


addMessage(
payload.new.ciphertext,
"left"
);


}

)

.subscribe();


}



start();
