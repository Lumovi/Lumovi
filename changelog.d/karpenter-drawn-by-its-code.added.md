- **Karpenter's overview is drawn by the Karpenter plugin**, whose code comes with Lumovi and runs
  in a sealed box: it reads only what its file says, as you, and changes nothing in your cluster. On
  a server it runs only in a browser Lumovi has checked keeps it apart, and whatever stands in front
  of the server (an ingress that lists its paths, a sign-in proxy) must let that check through:
  everything under `box-check/`, without a sign-in of its own; wherever it doesn't run, Lumovi's own
  overview of Karpenter is shown. A plugin's code can be turned off: by you, with **Run its code**
  on the Plugins page; on a server, for everyone or for all but the plugins named
  (`LUMOVI_PLUGIN_CODE`, the chart's `pluginCode`); or by an organization's policy
  (`plugins: no-code`), which can also let no plugin's page propose a change or show what's in a
  Secret (`pluginProposals`, `pluginSecrets`: `off`).
