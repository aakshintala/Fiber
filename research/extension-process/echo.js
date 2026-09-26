const rl=require('readline').createInterface({input:process.stdin});
rl.on('line',l=>{const m=JSON.parse(l);process.stdout.write(JSON.stringify({id:m.id,result:m.params})+"\n")});
