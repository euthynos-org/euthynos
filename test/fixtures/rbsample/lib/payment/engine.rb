FEE_RATE = 0.029


def compute_fee(amount)
  amount * FEE_RATE
end


def capture(amount)
  fee = compute_fee(amount)
  amount - fee
end
