// Dart payment engine — the cross-file call target.
int computeFee(int amount, {int tax = 0}) {
  return _scale(amount) + tax;
}

int _scale(int a) => a * 2;
