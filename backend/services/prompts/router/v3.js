
const v2 = require('./v2');

const TRIAGE_EXAMPLES = `Examples:
"Launch Preview" -> {"intent_class":"act","confidence":0.97,"reasoning":"Starts an application on this Mac; no R-category."}
"My trackpad keeps freezing, sort it out" -> {"intent_class":"act","confidence":0.85,"reasoning":"Needs this Mac inspected and adjusted; no R-category."}
"Has Priya replied to my message about the invoice?" -> {"intent_class":"act","confidence":0.93,"reasoning":"The user's own mailbox is live state and has to be opened; no R-category."}
"What does DNS stand for?" -> {"intent_class":"tell","confidence":0.96,"reasoning":"General knowledge; nothing on this Mac is touched."}
"what did my landlord's letter say about the deposit" -> {"intent_class":"tell","confidence":0.8,"reasoning":"Recalls an indexed document; a lookup, not an action."}
"ok" -> {"intent_class":"tell","confidence":0.3,"reasoning":"A fragment with no task in it."}
"Erase the whole SSD and start over" -> {"intent_class":"refuse","confidence":0.98,"reasoning":"R1: irreversible destruction of the user's system."}
"Log in to my neighbour's NAS and clean it up" -> {"intent_class":"refuse","confidence":0.95,"reasoning":"R5: another person's machine."}`;

const SELECTION_EXAMPLES = `Examples (with a catalogue that has "app-launch [app:string!]", "system-volume [level:number!]" and "count-lines-in-files [directory:string!, output_csv:string]" installed):
"Start Keynote" -> {"intent_type":"execute_existing","confidence":0.97,"reasoning":"app-launch starts an application by name.","target_skill":"app-launch","parameters":{"app":"Keynote"}}
"turn it down to 15" -> {"intent_type":"execute_existing","confidence":0.8,"reasoning":"system-volume sets the output level.","target_skill":"system-volume","parameters":{"level":15}}
"count the lines in the files under ~/thesis" -> {"intent_type":"execute_existing","confidence":0.92,"reasoning":"count-lines-in-files does exactly this; the output path is simply not given.","target_skill":"count-lines-in-files","parameters":{"directory":"~/thesis"}}
"count the characters in ~/thesis/intro.txt" -> {"intent_type":"generate_new_skill","confidence":0.85,"reasoning":"Characters are a different quantity from lines; nothing installed measures it.","target_skill":null,"parameters":{}}
"open Keynote and set the volume to 15" -> {"intent_type":"generate_new_skill","confidence":0.85,"reasoning":"Two operations chained; no single skill does both.","target_skill":null,"parameters":{}}
"convert every SVG in ~/icons to PNG" -> {"intent_type":"generate_new_skill","confidence":0.9,"reasoning":"No installed skill converts images.","target_skill":null,"parameters":{}}
"did Priya reply about the invoice?" -> {"intent_type":"generate_new_skill","confidence":0.9,"reasoning":"The mailbox is never an installed skill.","target_skill":null,"parameters":{}}`;

const SINGLE_EXAMPLES = `Examples (with "app-launch [app:string!]" and "count-lines-in-files [directory:string!, output_csv:string]" installed):
"Start Keynote" -> {"intent_type":"execute_existing","confidence":0.97,"reasoning":"app-launch starts an application by name.","target_skill":"app-launch","parameters":{"app":"Keynote"}}
"count the characters in ~/thesis/intro.txt" -> {"intent_type":"generate_new_skill","confidence":0.85,"reasoning":"Characters are a different quantity from lines; nothing installed measures it.","target_skill":null,"parameters":{}}
"did Priya reply about the invoice?" -> {"intent_type":"generate_new_skill","confidence":0.9,"reasoning":"The mailbox is live state and never an installed skill.","target_skill":null,"parameters":{}}
"What does DNS stand for?" -> {"intent_type":"answer","confidence":0.96,"reasoning":"General knowledge; nothing on this Mac is touched.","target_skill":null,"parameters":{}}
"ok" -> {"intent_type":"answer","confidence":0.3,"reasoning":"A fragment with no task in it.","target_skill":null,"parameters":{}}
"Erase the whole SSD and start over" -> {"intent_type":"refuse","confidence":0.98,"reasoning":"R1: irreversible destruction of the user's system.","target_skill":null,"parameters":{}}
"Log in to my neighbour's NAS and clean it up" -> {"intent_type":"refuse","confidence":0.95,"reasoning":"R5: another person's machine.","target_skill":null,"parameters":{}}`;

module.exports = {
    name: 'v3',
    triage: () => `${v2.triage()}\n\n${TRIAGE_EXAMPLES}`,
    selection: (skills) => `${v2.selection(skills)}\n\n${SELECTION_EXAMPLES}`,
    single: (skills) => `${v2.single(skills)}\n\n${SINGLE_EXAMPLES}`
};
