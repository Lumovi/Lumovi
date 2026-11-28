- **Installing or upgrading with Helm**: quitting while Lumovi is still checking the change, before
  helm itself runs, now asks first, as it does once helm runs. A chart on this computer says what
  it's still missing as soon as it's read again after Download dependencies, without waiting for
  helm lint, and a failed download's message goes as soon as another starts.
