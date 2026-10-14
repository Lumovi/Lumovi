- **Events as a timeline.** On the Events page and an object's Events tab, **List** | **Timeline**
  shows events where they fell in time: a row for each object (on an object's tab, each reason), a
  Normal event as a hollow circle and a Warning as a triangle, and one that repeated as a bar from
  its first time to its last, with how many times. It shows the last 15 minutes, the last hour, or
  every event kept, and dragging across it zooms in. Each mark says what happened when it's hovered
  or focused, and the keyboard moves through rows and marks. Kubernetes keeps events for about an
  hour unless its API server is set otherwise, and the timeline says so. On a phone, or where the
  page is too narrow, events stay a list.
