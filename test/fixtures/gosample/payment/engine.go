package payment

// ComputeFee returns the fee charged on an amount.
func ComputeFee(amount int) int {
	base := amount / 100
	return base + Tax(amount)
}

// Tax is the tax component of a fee.
func Tax(amount int) int {
	return amount / 20
}
