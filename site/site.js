// Pricing toggle. Without JavaScript both prices stay visible.
(function () {
  var plan = document.getElementById('plan');
  if (!plan) return;
  var toggle = plan.querySelector('.toggle');
  var buttons = plan.querySelectorAll('.toggle button');
  var options = plan.querySelectorAll('.price-opt');
  if (!toggle || !buttons.length) return;
  function show(which) {
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute('aria-pressed', buttons[i].getAttribute('data-plan') === which ? 'true' : 'false');
    }
    for (var j = 0; j < options.length; j++) {
      options[j].hidden = options[j].getAttribute('data-plan') !== which;
    }
  }
  for (var k = 0; k < buttons.length; k++) {
    buttons[k].addEventListener('click', function () { show(this.getAttribute('data-plan')); });
  }
  toggle.hidden = false;
  show('year');
})();
