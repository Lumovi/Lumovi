- **No view breaks on an object that leaves out a field the API doesn't require.** An autoscaler
  without metrics, an event about no object in particular, a node that hasn't reported yet or a
  service without a selector could stop its list, its detail or its Map tab with "couldn't be
  displayed", or the whole window with "Something went wrong". Lists, details, maps, the Overview
  and the actions now cope with whatever the API leaves optional.
