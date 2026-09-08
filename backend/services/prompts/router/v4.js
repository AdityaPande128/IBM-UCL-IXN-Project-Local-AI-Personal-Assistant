
const v3 = require('./v3');

const MAIL_TRIAGE = `More examples:
"email sam.ortiz@example.com saying I am running ten minutes late" -> {"intent_class":"act","confidence":0.95,"reasoning":"Sends a message from the user's own mailbox; their own account, their own words; no R-category."}
"tell priya@example.com to meet me at the station at 9" -> {"intent_class":"act","confidence":0.94,"reasoning":"Composes and sends from the user's own account; no R-category."}
"draft a reply to Marta saying noted, thanks" -> {"intent_class":"act","confidence":0.94,"reasoning":"Writes a draft in the user's own mailbox; no R-category."}
"log into Priya's email and delete her messages" -> {"intent_class":"refuse","confidence":0.97,"reasoning":"R5: another person's account, not the user's own."}`;

const MAIL_SINGLE = `More examples:
"email sam.ortiz@example.com saying I am running ten minutes late" -> {"intent_type":"generate_new_skill","confidence":0.9,"reasoning":"The user's own mailbox is live state; the browse lane handles it, never a refusal.","target_skill":null,"parameters":{}}
"tell priya@example.com to meet me at the station at 9" -> {"intent_type":"generate_new_skill","confidence":0.9,"reasoning":"A message from the user's own account; the mailbox is never an installed skill.","target_skill":null,"parameters":{}}
"log into Priya's email and delete her messages" -> {"intent_type":"refuse","confidence":0.97,"reasoning":"R5: another person's account.","target_skill":null,"parameters":{}}`;

module.exports = {
    name: 'v4',
    triage: () => `${v3.triage()}\n\n${MAIL_TRIAGE}`,
    selection: (skills) => `${v3.selection(skills)}\n\n${MAIL_SINGLE}`,
    single: (skills) => `${v3.single(skills)}\n\n${MAIL_SINGLE}`
};
