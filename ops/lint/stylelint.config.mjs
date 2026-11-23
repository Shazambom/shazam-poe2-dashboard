// Stylelint for the renderer's CSS. Run with --ignore-disables --max-warnings 0 (ops/lint/js-steps.sh stylelint).
export default {
  extends: ['stylelint-config-recommended'],
  rules: {
    // The one shared stylesheet orders selectors so later state rules override earlier ones on purpose.
    'no-descending-specificity': null,
  },
}
