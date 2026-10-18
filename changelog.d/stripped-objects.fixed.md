- **No view breaks on an object that leaves fields out.** An autoscaler without metrics, an event
  about no object in particular, a node that hasn't reported yet or a service without a selector
  could stop its detail, its list, its Map tab or even the whole window with "couldn't be
  displayed". Every list, detail, map and the Overview now cope with whatever the API leaves
  optional.
