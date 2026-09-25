from probe_openrouter import *
import sys
for label,sys_ttl in [('1h at end only, system unmarked',None),('1h on system and end',"1h")]:
    n=uuid.uuid4().hex[:12]; b=base(n,SON); w=call(b); time.sleep(3)
    v=copy.deepcopy(b); strip_cc(v['messages'])
    if sys_ttl: v['messages'][0]['content'][0]['cache_control']={'type':'ephemeral','ttl':'1h'}
    v['messages']+=[{'role':'assistant','content':'ok'},{'role':'user','content':'Again.'}]; mark_last(v['messages'],'1h')
    r=call(v); row(label,('warm5m',w),('1h',r)); print('  ',json.dumps(r.get('u'))[:400] if 'u' in r else r)
    time.sleep(3); v2=copy.deepcopy(v); strip_cc(v2['messages'])
    if sys_ttl: v2['messages'][0]['content'][0]['cache_control']={'type':'ephemeral','ttl':'1h'}
    v2['messages']+=[{'role':'assistant','content':'ok'},{'role':'user','content':'Third.'}]; mark_last(v2['messages'],'1h')
    r2=call(v2); row('  next request, same policy',('r',r2)); print('  ',json.dumps(r2.get('u'))[:400] if 'u' in r2 else r2)
