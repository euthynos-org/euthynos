using System;

namespace Billing {
  public class Invoice {
    private int total;
    public Invoice(int total) { this.total = total; }
    public int Compute(int amount, int tax = 0) {
      return Round(amount) + tax;
    }
    private int Round(int a) => a;
  }
}
