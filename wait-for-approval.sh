#!/bin/zsh
# Polls Meta every 2 minutes (for up to 3 hours) until the template is approved, then sends one real test reminder.
cd ~/assignment-reminder
for i in {1..90}; do
  STATUS=$(node -e "
const c=require('./config.json');
fetch('https://graph.facebook.com/v25.0/'+c.whatsapp_business_account_id+'/message_templates?name='+c.template_name+'&fields=status',{headers:{Authorization:'Bearer '+c.access_token}}).then(r=>r.json()).then(d=>console.log(d.data[0].status))")
  echo "$(date +%H:%M) $STATUS"
  if [[ "$STATUS" == "APPROVED" ]]; then
    node -e "
const c=require('./config.json');
fetch('https://graph.facebook.com/v25.0/'+c.phone_number_id+'/messages',{method:'POST',headers:{Authorization:'Bearer '+c.access_token,'Content-Type':'application/json'},body:JSON.stringify({messaging_product:'whatsapp',to:c.send_to,type:'template',template:{name:c.template_name,language:{code:c.template_language},components:[{type:'body',parameters:[{type:'text',text:'TEST Homework'},{type:'text',text:'Corporate Finance'},{type:'text',text:'14:00'}]}]}})}).then(r=>r.json()).then(d=>console.log(JSON.stringify(d)))"
    exit 0
  fi
  if [[ "$STATUS" == "REJECTED" ]]; then exit 1; fi
  sleep 120
done
exit 2
