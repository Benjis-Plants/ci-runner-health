// STUB — replaced by the implementer. Contract (fixed by the locked tests):
//   decide({state, online, currentVar, now}) -> {state, actions}
//     now / lastAlert are epoch milliseconds (numbers).
//     actions: {type:'set_var', value} | {type:'slack', kind:'flip'|'unhealthy'} | {type:'requeue'}
//   countOnline(runners) -> number; runners are GitHub API objects:
//     {status:'online'|'offline', labels:[{name}]}
export function decide() {
  throw new Error('NotImplemented');
}
export function countOnline() {
  throw new Error('NotImplemented');
}
